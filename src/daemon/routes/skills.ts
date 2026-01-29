/**
 * Skills API routes
 */

import { Hono } from "hono";
import {
  discoverSkills,
  createSkill,
  removeSkill,
  installSkillFromGitHub,
  installSkillFromUrl,
  clearSkillCache,
} from "../../core/skills.js";
import {
  getRegistries,
  addRegistry,
  removeRegistry,
  searchAllRegistries,
} from "../../core/registries.js";

export const skillsRouter = new Hono();

// List installed skills
skillsRouter.get("/", (c) => {
  const { skills, warnings } = discoverSkills();
  return c.json({ skills, warnings: warnings.length > 0 ? warnings : undefined });
});

// Create a new skill
skillsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { name, description } = body;

  if (!name) {
    return c.json({ error: "name is required" }, 400);
  }

  try {
    const skill = createSkill(name, description);
    return c.json({ created: true, skill }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Install skill from source
skillsRouter.post("/install", async (c) => {
  const body = await c.req.json();
  const { source, name } = body;

  if (!source) {
    return c.json({ error: "source is required" }, 400);
  }

  try {
    let skill;
    if (source.startsWith("github:")) {
      const parts = source.replace("github:", "").split("/");
      const [owner, repo, ...pathParts] = parts;
      const skillPath = pathParts.join("/");
      skill = installSkillFromGitHub(owner, repo, skillPath, name);
    } else {
      skill = installSkillFromUrl(source, name);
    }
    return c.json({ installed: true, skill }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Remove skill
skillsRouter.delete("/:name", (c) => {
  const name = c.req.param("name");

  try {
    removeSkill(name);
    return c.json({ removed: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Search registries for skills
skillsRouter.get("/search", async (c) => {
  const query = c.req.query("q");

  if (!query) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const results = await searchAllRegistries(query);
  return c.json({ results });
});

// Clear skill cache
skillsRouter.post("/cache/clear", (c) => {
  clearSkillCache();
  return c.json({ cleared: true });
});

// Skill registries
skillsRouter.get("/registries", (c) => {
  const registries = getRegistries();
  return c.json({ registries });
});

skillsRouter.post("/registries", async (c) => {
  const body = await c.req.json();
  const { name, url } = body;

  if (!name || !url) {
    return c.json({ error: "name and url are required" }, 400);
  }

  addRegistry(name, url);
  return c.json({ added: true, name, url }, 201);
});

skillsRouter.delete("/registries/:name", (c) => {
  const name = c.req.param("name");
  const removed = removeRegistry(name);

  if (!removed) {
    return c.json({ error: "Registry not found" }, 404);
  }

  return c.json({ removed: true });
});
