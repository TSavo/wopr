/**
 * Crons API routes
 */

import { Hono } from "hono";
import {
  getCrons,
  addCron,
  removeCron,
  getCron,
  createOnceJob,
} from "../../core/cron.js";
import { inject } from "../../core/sessions.js";
import type { CronJob } from "../../types.js";

export const cronsRouter = new Hono();

// List all crons
cronsRouter.get("/", (c) => {
  const crons = getCrons();
  return c.json({ crons });
});

// Get specific cron
cronsRouter.get("/:name", (c) => {
  const name = c.req.param("name");
  const cron = getCron(name);

  if (!cron) {
    return c.json({ error: "Cron not found" }, 404);
  }

  return c.json(cron);
});

// Create cron job
cronsRouter.post("/", async (c) => {
  const body = await c.req.json();
  const { name, schedule, session, message, once, runNow } = body;

  if (!name || !schedule || !session || !message) {
    return c.json({ error: "Missing required fields: name, schedule, session, message" }, 400);
  }

  const job: CronJob = {
    name,
    schedule,
    session,
    message,
    once: once || undefined,
  };

  addCron(job);

  // Optionally run immediately
  if (runNow) {
    await inject(session, message, { silent: true, from: "cron" });
  }

  return c.json({ created: true, cron: job }, 201);
});

// Create one-time job
cronsRouter.post("/once", async (c) => {
  const body = await c.req.json();
  const { time, session, message } = body;

  if (!time || !session || !message) {
    return c.json({ error: "Missing required fields: time, session, message" }, 400);
  }

  try {
    const job = createOnceJob(time, session, message);
    addCron(job);

    return c.json({
      created: true,
      cron: job,
      scheduledFor: new Date(job.runAt!).toISOString(),
    }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Run immediately (no scheduling)
cronsRouter.post("/now", async (c) => {
  const body = await c.req.json();
  const { session, message } = body;

  if (!session || !message) {
    return c.json({ error: "Missing required fields: session, message" }, 400);
  }

  const result = await inject(session, message, { silent: true, from: "cron" });

  return c.json({
    session,
    response: result.response,
    cost: result.cost,
  });
});

// Delete cron
cronsRouter.delete("/:name", (c) => {
  const name = c.req.param("name");
  const removed = removeCron(name);

  if (!removed) {
    return c.json({ error: "Cron not found" }, 404);
  }

  return c.json({ deleted: true });
});
