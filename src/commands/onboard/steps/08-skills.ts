/**
 * Step 8: Skills setup
 */
import { multiselect, note, confirm, pc } from "../prompts.js";
import { AVAILABLE_SKILLS } from "../types.js";
import type { OnboardContext, OnboardStep } from "../types.js";

export const skillsStep: OnboardStep = async (ctx: OnboardContext) => {
  if (ctx.opts.skipSkills) {
    await note("Skipping skills setup (--skip-skills)", "Skills");
    return {};
  }
  
  const isQuickstart = ctx.opts.flow === "quickstart";
  
  await note([
    "Skills give your agent capabilities.",
    "",
    "Available:",
    ...AVAILABLE_SKILLS.map(s => `  • ${s.name}: ${s.description}`),
    "",
    pc.dim("Skills are loaded from ~/.wopr/skills/"),
  ].join("\n"), "Skills");
  
  let selectedSkills: string[];
  
  if (isQuickstart) {
    // QuickStart: recommend file-ops and memory
    const useRecommended = await confirm({
      message: "Install recommended skills (file-ops, memory)?",
      initialValue: true,
    });
    
    if (useRecommended) {
      selectedSkills = ["file-ops", "memory"];
    } else {
      selectedSkills = [];
    }
  } else {
    // Advanced: let them choose
    const options = AVAILABLE_SKILLS.map(s => ({
      value: s.id,
      label: s.name,
      hint: s.description,
    }));
    
    selectedSkills = await multiselect({
      message: "Select skills to enable",
      options,
      required: false,
      initialValues: ["file-ops", "memory"],
    });
  }
  
  if (selectedSkills.includes("web-search")) {
    await note([
      "Web search requires a Brave Search API key.",
      "",
      "Get one free at: https://api.search.brave.com/",
      "",
      "Then configure with: wopr configure --skill web-search",
    ].join("\n"), "Web Search Setup");
  }
  
  await note([
    `${selectedSkills.length} skill(s) selected`,
    selectedSkills.length > 0 ? `  • ${selectedSkills.join("\n  • ")}` : "",
    "",
    pc.dim("Skills will be loaded automatically from the skills directory."),
  ].join("\n"), "Skills");
  
  return { skills: selectedSkills };
};
