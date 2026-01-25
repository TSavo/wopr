import { join } from "path";
import { homedir } from "os";

export const WOPR_HOME = process.env.WOPR_HOME || join(homedir(), "wopr");
export const SESSIONS_DIR = join(WOPR_HOME, "sessions");
export const SKILLS_DIR = join(WOPR_HOME, "skills");
export const SESSIONS_FILE = join(WOPR_HOME, "sessions.json");
export const REGISTRIES_FILE = join(WOPR_HOME, "registries.json");
export const CRONS_FILE = join(WOPR_HOME, "crons.json");
export const PID_FILE = join(WOPR_HOME, "daemon.pid");
export const LOG_FILE = join(WOPR_HOME, "daemon.log");
export const IDENTITY_FILE = join(WOPR_HOME, "identity.json");
export const ACCESS_FILE = join(WOPR_HOME, "access.json");
export const PEERS_FILE = join(WOPR_HOME, "peers.json");
export const AUTH_FILE = join(WOPR_HOME, "auth.json");
