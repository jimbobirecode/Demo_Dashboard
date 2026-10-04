/**
 * Load the repository's `.env` before anything reads process.env.
 *
 * The file lives at the repository root, but `npm run dev` starts the API
 * from `server/` (npm workspaces run scripts in the workspace directory),
 * where dotenv's default — `.env` in the current directory — would find
 * nothing. Resolving the path from this file works from any directory.
 * Variables already set in the environment (Render, CI) always win.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');

dotenv.config({ path: ENV_FILE, quiet: true });
