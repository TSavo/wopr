/**
 * Skill discovery and management
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { WOPR_HOME, SKILLS_DIR } from "../paths.js";

// Ensure skills directory exists
if (!existsSync(SKILLS_DIR)) {
  mkdirSync(SKILLS_DIR, { recursive: true });
}

export interface Skill {
  name: string;
  description: string;
  path: string;
}

export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

export function discoverSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return [];

  const skills: Skill[] = [];
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory());

  for (const dir of dirs) {
    const skillPath = join(SKILLS_DIR, dir.name, "SKILL.md");
    if (existsSync(skillPath)) {
      const content = readFileSync(skillPath, "utf-8");
      const { name, description } = parseSkillFrontmatter(content);
      skills.push({
        name: name || dir.name,
        description: description || `Skill: ${dir.name}`,
        path: skillPath,
      });
    }
  }
  return skills;
}

export function formatSkillsXml(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const skillsXml = skills.map(s =>
    `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
    <location>${s.path}</location>
  </skill>`
  ).join("\n");

  return `
<available_skills>
${skillsXml}
</available_skills>

When you need to use a skill, read its full SKILL.md file at the location shown above.
`;
}

export function createSkill(name: string, description?: string): Skill {
  const targetDir = join(SKILLS_DIR, name);
  if (existsSync(targetDir)) {
    throw new Error(`Skill "${name}" already exists`);
  }

  mkdirSync(targetDir, { recursive: true });
  const desc = description || `WOPR skill: ${name}`;
  const skillPath = join(targetDir, "SKILL.md");
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);

  return {
    name,
    description: desc,
    path: skillPath,
  };
}

export function removeSkill(name: string): void {
  const targetDir = join(SKILLS_DIR, name);
  if (!existsSync(targetDir)) {
    throw new Error(`Skill "${name}" not found`);
  }
  execSync(`rm -rf "${targetDir}"`);
}

export function installSkillFromGitHub(
  owner: string,
  repo: string,
  skillPath: string,
  name?: string
): Skill {
  const skillName = name || skillPath.split("/").pop()!;
  const targetDir = join(SKILLS_DIR, skillName);

  if (existsSync(targetDir)) {
    throw new Error(`Skill "${skillName}" already exists`);
  }

  const tmpDir = join(SKILLS_DIR, `.tmp-${Date.now()}`);
  try {
    execSync(`git clone --depth 1 --filter=blob:none --sparse https://github.com/${owner}/${repo}.git "${tmpDir}"`, { stdio: "pipe" });
    execSync(`git -C "${tmpDir}" sparse-checkout set "${skillPath}"`, { stdio: "pipe" });
    execSync(`mv "${tmpDir}/${skillPath}" "${targetDir}"`, { stdio: "pipe" });
    execSync(`rm -rf "${tmpDir}"`, { stdio: "pipe" });
  } catch {
    execSync(`rm -rf "${tmpDir}"`, { stdio: "ignore" });
    throw new Error("Failed to install skill from GitHub");
  }

  const skill = discoverSkills().find(s => s.name === skillName);
  if (!skill) {
    throw new Error("Skill installed but not discoverable");
  }
  return skill;
}

export function installSkillFromUrl(source: string, name?: string): Skill {
  const skillName = name || basename(source).replace(/\.git$/, "");
  const targetDir = join(SKILLS_DIR, skillName);

  if (existsSync(targetDir)) {
    throw new Error(`Skill "${skillName}" already exists`);
  }

  execSync(`git clone "${source}" "${targetDir}"`, { stdio: "inherit" });

  const skill = discoverSkills().find(s => s.name === skillName);
  if (!skill) {
    throw new Error("Skill installed but not discoverable");
  }
  return skill;
}

export function clearSkillCache(): void {
  const cacheDir = join(WOPR_HOME, ".cache");
  if (existsSync(cacheDir)) {
    execSync(`rm -rf "${cacheDir}"`);
  }
}
