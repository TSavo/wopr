import { logger } from "../logger.js";
/**
 * Skill registry management
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { WOPR_HOME, REGISTRIES_FILE } from "../paths.js";
import type { Registry, SkillPointer } from "../types.js";
import { parseSkillFrontmatter } from "./skills.js";

export function getRegistries(): Registry[] {
  if (!existsSync(REGISTRIES_FILE)) return [];
  return JSON.parse(readFileSync(REGISTRIES_FILE, "utf-8"));
}

export function saveRegistries(registries: Registry[]): void {
  writeFileSync(REGISTRIES_FILE, JSON.stringify(registries, null, 2));
}

export function addRegistry(name: string, url: string): void {
  const registries = getRegistries().filter(r => r.name !== name);
  registries.push({ name, url });
  saveRegistries(registries);
}

export function removeRegistry(name: string): boolean {
  const registries = getRegistries();
  const filtered = registries.filter(r => r.name !== name);
  if (filtered.length === registries.length) return false;
  saveRegistries(filtered);
  return true;
}

export async function fetchRegistryIndex(url: string, searchQuery?: string): Promise<SkillPointer[]> {
  if (url.startsWith("github:")) {
    const parts = url.replace("github:", "").split("/");
    const owner = parts[0];
    const repo = parts[1];
    const path = parts.slice(2).join("/") || "skills";
    return await fetchGitHubSkills(owner, repo, path, searchQuery);
  }

  if (url.includes("github.com") && !url.includes("/raw/")) {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/[^\/]+\/(.+))?/);
    if (match) {
      const [, owner, repo, path] = match;
      return await fetchGitHubSkills(owner, repo, path || "skills", searchQuery);
    }
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.items && Array.isArray(data.items)) {
      return data.items.map((item: any) => ({
        name: item.slug || item.name,
        description: item.summary || item.description || item.displayName || "",
        source: item.source || item.repository || item.url,
        version: item.latestVersion?.version || item.version,
      }));
    }

    if (Array.isArray(data)) return data as SkillPointer[];
    if (data.skills && Array.isArray(data.skills)) return data.skills as SkillPointer[];
    return [];
  } catch {
    return [];
  }
}

async function fetchGitHubSkills(
  owner: string,
  repo: string,
  path: string,
  searchQuery?: string
): Promise<SkillPointer[]> {
  const token = process.env.GITHUB_TOKEN;

  if (token) {
    const skills: SkillPointer[] = [];
    const q = searchQuery
      ? `${searchQuery}+filename:SKILL.md+repo:${owner}/${repo}+path:${path}`
      : `filename:SKILL.md+repo:${owner}/${repo}+path:${path}`;

    try {
      for (let page = 1; page <= 6; page++) {
        const res = await fetch(
          `https://api.github.com/search/code?q=${q}&per_page=100&page=${page}`,
          { headers: { Authorization: `token ${token}` } }
        );
        if (!res.ok) break;
        const data = await res.json();
        if (!data.items?.length) break;

        for (const item of data.items) {
          const parts = item.path.replace(/\/SKILL\.md$/i, "").split("/");
          skills.push({
            name: parts[parts.length - 1],
            description: "",
            source: `github:${owner}/${repo}/${parts.join("/")}`,
          });
        }
        if (data.items.length < 100) break;
      }
    } catch { /* fall through to clone */ }

    if (skills.length > 0) return skills;
  }

  const cacheDir = join(WOPR_HOME, ".cache", `${owner}-${repo}`);

  if (!existsSync(cacheDir)) {
    logger.info(`Caching ${owner}/${repo}...`);
    mkdirSync(join(WOPR_HOME, ".cache"), { recursive: true });
    try {
      execSync(`git clone --depth 1 https://github.com/${owner}/${repo}.git "${cacheDir}"`, { stdio: "pipe" });
    } catch {
      logger.error(`Failed to clone ${owner}/${repo}`);
      return [];
    }
  } else {
    try {
      execSync(`git -C "${cacheDir}" pull --depth 1`, { stdio: "pipe" });
    } catch { /* ignore */ }
  }

  const skills: SkillPointer[] = [];
  const skillsPath = join(cacheDir, path);
  if (!existsSync(skillsPath)) return [];

  const q = searchQuery?.toLowerCase();

  function scanDir(dir: string, depth: number): void {
    if (depth > 2) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subdir = join(dir, entry.name);
      const skillMd = join(subdir, "SKILL.md");

      if (existsSync(skillMd)) {
        const content = readFileSync(skillMd, "utf-8");
        const meta = parseSkillFrontmatter(content);
        if (!q || entry.name.toLowerCase().includes(q) || content.toLowerCase().includes(q)) {
          skills.push({
            name: entry.name,
            description: meta.description || "",
            source: `github:${owner}/${repo}/${subdir.replace(cacheDir + "/", "")}`,
          });
        }
      } else {
        scanDir(subdir, depth + 1);
      }
    }
  }

  scanDir(skillsPath, 0);
  return skills;
}

export async function searchAllRegistries(query: string): Promise<{ registry: string; skill: SkillPointer }[]> {
  const registries = getRegistries();
  const results: { registry: string; skill: SkillPointer }[] = [];

  for (const reg of registries) {
    const skills = await fetchRegistryIndex(reg.url, query);
    for (const skill of skills) {
      results.push({ registry: reg.name, skill });
    }
  }

  return results;
}
