/**
 * Skill discovery and management
 * Feature parity with Clawdbot skills system
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, realpathSync } from "fs";
import { join, basename, dirname, resolve } from "path";
import { execSync } from "child_process";
import { homedir } from "os";
import { WOPR_HOME, SKILLS_DIR, PROJECT_SKILLS_DIR } from "../paths.js";
import { logger } from "../logger.js";

// ============================================================================
// Skill Validation Constants (per Agent Skills spec)
// ============================================================================

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const NAME_PATTERN = /^[a-z0-9-]+$/;
const ALLOWED_FRONTMATTER_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "command-dispatch",
  "command-tool",
  "command-arg-mode",
]);

// ============================================================================
// Skill Interfaces
// ============================================================================

export interface SkillMetadata {
  emoji?: string;
  requires?: {
    bins?: string[];
    libs?: string[];
  };
  install?: SkillInstallStep[];
}

export interface SkillInstallStep {
  id: string;
  kind: "brew" | "apt" | "npm" | "pip" | "script";
  formula?: string;
  package?: string;
  script?: string;
  bins?: string[];
  label?: string;
}

export interface SkillCommandDispatch {
  kind: "tool";
  toolName: string;
  argMode: "raw";
}

export interface Skill {
  name: string;
  description: string;
  path: string;
  baseDir: string;
  source: string;
  metadata?: SkillMetadata;
  allowedTools?: string[];
  commandDispatch?: SkillCommandDispatch;
}

export interface SkillValidationWarning {
  skillPath: string;
  message: string;
}

export interface SkillEntry {
  skill: Skill;
  frontmatter: Record<string, any>;
  woprMetadata?: SkillMetadata;
  invocation: {
    disableModelInvocation?: boolean;
    userInvocable?: boolean;
  };
}

// ============================================================================
// Validation Functions
// ============================================================================

export function validateSkillName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!NAME_PATTERN.test(name)) {
    errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`name must not start or end with a hyphen`);
  }
  if (name.includes("--")) {
    errors.push(`name must not contain consecutive hyphens`);
  }
  
  return errors;
}

export function validateSkillDescription(description?: string): string[] {
  const errors: string[] = [];
  
  if (!description || description.trim() === "") {
    errors.push(`description is required`);
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  
  return errors;
}

export function validateFrontmatterFields(keys: string[]): string[] {
  const errors: string[] = [];
  for (const key of keys) {
    if (!ALLOWED_FRONTMATTER_FIELDS.has(key)) {
      errors.push(`unknown frontmatter field "${key}"`);
    }
  }
  return errors;
}

// ============================================================================
// Frontmatter Parsing
// ============================================================================

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: string | Record<string, any>;
  "allowed-tools"?: string[];
  "command-dispatch"?: string;
  "command-tool"?: string;
  "command-arg-mode"?: string;
}

export function parseSkillFrontmatter(content: string): { 
  frontmatter: ParsedFrontmatter; 
  body: string;
  warnings: SkillValidationWarning[];
} {
  const warnings: SkillValidationWarning[] = [];
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  
  if (!match) {
    return { frontmatter: {}, body: content, warnings };
  }
  
  const yamlContent = match[1];
  const body = match[2];
  const frontmatter: ParsedFrontmatter = {};
  
  // Parse YAML-like frontmatter
  for (const line of yamlContent.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    
    const key = line.slice(0, colonIndex).trim();
    let value: any = line.slice(colonIndex + 1).trim();
    
    // Try to parse JSON metadata
    if (key === "metadata") {
      try {
        value = JSON.parse(value);
      } catch {
        // Keep as string if not valid JSON
      }
    }
    
    // Parse arrays
    if (key === "allowed-tools") {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.split(",").map((s: string) => s.trim());
      }
    }
    
    (frontmatter as any)[key] = value;
  }
  
  // Validate frontmatter fields
  const fieldErrors = validateFrontmatterFields(Object.keys(frontmatter));
  for (const error of fieldErrors) {
    warnings.push({ skillPath: "", message: error });
  }
  
  return { frontmatter, body, warnings };
}

export function resolveWoprMetadata(frontmatter: ParsedFrontmatter): SkillMetadata | undefined {
  if (!frontmatter.metadata) return undefined;
  
  if (typeof frontmatter.metadata === "string") {
    try {
      const parsed = JSON.parse(frontmatter.metadata);
      return parsed.wopr || parsed.clawdbot;
    } catch {
      return undefined;
    }
  }
  
  return frontmatter.metadata.wopr || frontmatter.metadata.clawdbot;
}

export function resolveSkillInvocationPolicy(frontmatter: ParsedFrontmatter): {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
} {
  return {
    disableModelInvocation: false,
    userInvocable: true,
  };
}

export function resolveCommandDispatch(frontmatter: ParsedFrontmatter): SkillCommandDispatch | undefined {
  const dispatch = frontmatter["command-dispatch"]?.trim().toLowerCase();
  if (dispatch !== "tool") return undefined;
  
  const toolName = frontmatter["command-tool"]?.trim();
  if (!toolName) {
    logger.warn(`Skill requested tool dispatch but did not provide command-tool`);
    return undefined;
  }
  
  const argMode = frontmatter["command-arg-mode"]?.trim().toLowerCase();
  return {
    kind: "tool",
    toolName,
    argMode: !argMode || argMode === "raw" ? "raw" : "raw",
  };
}

// ============================================================================
// Skill Discovery
// ============================================================================

export interface DiscoverOptions {
  extraDirs?: string[];
  bundledDir?: string;
  managedDir?: string;
  workspaceDir?: string;
  includeSkills?: string[];
  ignoreSkills?: string[];
}

function loadSkillsFromDir(dir: string, source: string): { 
  entries: SkillEntry[]; 
  warnings: SkillValidationWarning[];
} {
  const entries: SkillEntry[] = [];
  const warnings: SkillValidationWarning[] = [];
  
  if (!existsSync(dir)) {
    return { entries, warnings };
  }
  
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    
    for (const item of items) {
      // Skip hidden files and node_modules
      if (item.name.startsWith(".") || item.name === "node_modules") {
        continue;
      }
      
      let isDirectory = item.isDirectory();
      let isSymlink = item.isSymbolicLink();
      
      // Follow symlinks
      if (isSymlink) {
        try {
          const stats = statSync(join(dir, item.name));
          isDirectory = stats.isDirectory();
        } catch {
          continue; // Broken symlink
        }
      }
      
      if (isDirectory) {
        const skillFile = join(dir, item.name, "SKILL.md");
        if (!existsSync(skillFile)) {
          continue;
        }
        
        const result = loadSkillFromFile(skillFile, source);
        if (result.entry) {
          entries.push(result.entry);
        }
        warnings.push(...result.warnings);
      }
    }
  } catch (error) {
    logger.warn(`Failed to load skills from ${dir}:`, error);
  }
  
  return { entries, warnings };
}

function loadSkillFromFile(filePath: string, source: string): { 
  entry: SkillEntry | null; 
  warnings: SkillValidationWarning[];
} {
  const warnings: SkillValidationWarning[] = [];
  
  try {
    const content = readFileSync(filePath, "utf-8");
    const { frontmatter, warnings: fmWarnings } = parseSkillFrontmatter(content);
    
    // Add filepath to warnings
    for (const w of fmWarnings) {
      w.skillPath = filePath;
    }
    warnings.push(...fmWarnings);
    
    const skillDir = dirname(filePath);
    const parentDirName = basename(skillDir);
    
    // Get name from frontmatter or directory
    const name = frontmatter.name || parentDirName;
    
    // Validate
    const nameErrors = validateSkillName(name, parentDirName);
    for (const error of nameErrors) {
      warnings.push({ skillPath: filePath, message: error });
    }
    
    const descErrors = validateSkillDescription(frontmatter.description);
    for (const error of descErrors) {
      warnings.push({ skillPath: filePath, message: error });
    }
    
    // Must have description
    if (!frontmatter.description || frontmatter.description.trim() === "") {
      return { entry: null, warnings };
    }
    
    const entry: SkillEntry = {
      skill: {
        name,
        description: frontmatter.description,
        path: filePath,
        baseDir: skillDir,
        source,
        metadata: resolveWoprMetadata(frontmatter),
        allowedTools: frontmatter["allowed-tools"],
        commandDispatch: resolveCommandDispatch(frontmatter),
      },
      frontmatter,
      woprMetadata: resolveWoprMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
    
    return { entry, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to parse skill file";
    warnings.push({ skillPath: filePath, message });
    return { entry: null, warnings };
  }
}

function matchesPattern(name: string, patterns: string[]): boolean {
  return patterns.some(pattern => {
    // Simple glob matching
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
    );
    return regex.test(name);
  });
}

export function discoverSkills(options: DiscoverOptions = {}): { 
  skills: Skill[]; 
  warnings: SkillValidationWarning[];
} {
  const allWarnings: SkillValidationWarning[] = [];
  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  
  const {
    extraDirs = [],
    bundledDir,
    managedDir = SKILLS_DIR,
    workspaceDir = PROJECT_SKILLS_DIR,
    includeSkills = [],
    ignoreSkills = [],
  } = options;
  
  // Load from all sources (precedence: extra < bundled < managed < workspace)
  const sources: { dir: string; source: string }[] = [
    ...extraDirs.map(d => ({ dir: resolve(d.replace(/^~/, homedir())), source: "extra" })),
    ...(bundledDir ? [{ dir: bundledDir, source: "bundled" }] : []),
    { dir: managedDir, source: "managed" },
    { dir: workspaceDir, source: "workspace" },
  ];
  
  for (const { dir, source } of sources) {
    const { entries, warnings } = loadSkillsFromDir(dir, source);
    allWarnings.push(...warnings);
    
    for (const entry of entries) {
      const { skill } = entry;
      
      // Apply filters
      if (ignoreSkills.length > 0 && matchesPattern(skill.name, ignoreSkills)) {
        continue;
      }
      if (includeSkills.length > 0 && !matchesPattern(skill.name, includeSkills)) {
        continue;
      }
      
      // Resolve symlinks for deduplication
      let realPath: string;
      try {
        realPath = realpathSync(skill.path);
      } catch {
        realPath = skill.path;
      }
      
      if (realPathSet.has(realPath)) {
        continue; // Skip duplicate
      }
      
      // Check for name collisions
      const existing = skillMap.get(skill.name);
      if (existing) {
        allWarnings.push({
          skillPath: skill.path,
          message: `name collision: "${skill.name}" already loaded from ${existing.path}, skipping`,
        });
        continue;
      }
      
      skillMap.set(skill.name, skill);
      realPathSet.add(realPath);
    }
  }
  
  return {
    skills: Array.from(skillMap.values()),
    warnings: allWarnings,
  };
}

// Legacy discover function for backward compatibility
export function discoverSkillsLegacy(): Skill[] {
  return discoverSkills().skills;
}

// ============================================================================
// Skill Formatting
// ============================================================================

export function formatSkillsXml(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const skillsXml = skills.map(s => {
    const emoji = s.metadata?.emoji ? `${s.metadata.emoji} ` : "";
    return `  <skill>
    <name>${s.name}</name>
    <description>${emoji}${s.description}</description>
    <location>${s.path}</location>
  </skill>`;
  }).join("\n");

  return `
<available_skills>
${skillsXml}
</available_skills>

When you need to use a skill, read its full SKILL.md file at the location shown above.
`;
}

export function buildSkillsPrompt(skills: Skill[]): string {
  return formatSkillsXml(skills);
}

// ============================================================================
// Skill Commands (Slash Commands)
// ============================================================================

const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) return base;
  
  for (let index = 2; index < 1000; index++) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  
  return `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
}

export function buildSkillCommandSpecs(
  skills: Skill[],
  reservedNames: string[] = []
): Array<{
  name: string;
  skillName: string;
  description: string;
  dispatch?: SkillCommandDispatch;
}> {
  const used = new Set<string>(reservedNames.map(r => r.toLowerCase()));
  
  return skills
    .filter(s => s.commandDispatch) // Only skills with command dispatch
    .map(skill => {
      const base = sanitizeSkillCommandName(skill.name);
      const unique = resolveUniqueSkillCommandName(base, used);
      used.add(unique.toLowerCase());
      
      const rawDescription = skill.description?.trim() || skill.name;
      const description = rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : rawDescription;
      
      return {
        name: unique,
        skillName: skill.name,
        description,
        ...(skill.commandDispatch ? { dispatch: skill.commandDispatch } : {}),
      };
    });
}

// ============================================================================
// Dependency Checking
// ============================================================================

export function checkSkillDependencies(skill: Skill): { 
  missing: string[]; 
  satisfied: boolean;
} {
  const missing: string[] = [];
  const requires = skill.metadata?.requires;
  
  if (requires?.bins) {
    for (const bin of requires.bins) {
      try {
        execSync(`which "${bin}"`, { stdio: "ignore" });
      } catch {
        missing.push(bin);
      }
    }
  }
  
  return { missing, satisfied: missing.length === 0 };
}

export async function installSkillDependencies(skill: Skill): Promise<boolean> {
  const installSteps = skill.metadata?.install;
  if (!installSteps || installSteps.length === 0) return true;
  
  logger.info(`Installing dependencies for skill: ${skill.name}`);
  
  for (const step of installSteps) {
    try {
      switch (step.kind) {
        case "brew":
          if (step.formula) {
            execSync(`brew install "${step.formula}"`, { stdio: "inherit" });
          }
          break;
        case "apt":
          if (step.package) {
            execSync(`sudo apt-get install -y "${step.package}"`, { stdio: "inherit" });
          }
          break;
        case "npm":
          if (step.package) {
            execSync(`npm install -g "${step.package}"`, { stdio: "inherit" });
          }
          break;
        case "script":
          if (step.script) {
            execSync(step.script, { stdio: "inherit", shell: "/bin/bash" });
          }
          break;
      }
    } catch (error) {
      logger.error(`Failed to install ${step.id}:`, error);
      return false;
    }
  }
  
  return true;
}

// ============================================================================
// Legacy Functions (Backward Compatibility)
// ============================================================================

export function createSkill(name: string, description?: string): Skill {
  const targetDir = join(SKILLS_DIR, name);
  if (existsSync(targetDir)) {
    throw new Error(`Skill "${name}" already exists`);
  }

  mkdirSync(targetDir, { recursive: true });
  const desc = description || `WOPR skill: ${name}`;
  const skillPath = join(targetDir, "SKILL.md");
  writeFileSync(skillPath, `---
name: ${name}
description: ${desc}
---

# ${name}
`);

  return {
    name,
    description: desc,
    path: skillPath,
    baseDir: targetDir,
    source: "managed",
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

  const skill = discoverSkillsLegacy().find(s => s.name === skillName);
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

  const skill = discoverSkillsLegacy().find(s => s.name === skillName);
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
