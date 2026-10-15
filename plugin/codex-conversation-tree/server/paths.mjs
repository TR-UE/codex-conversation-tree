import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
export function findCodex({ home = os.homedir(), env = process.env, preferred } = {}) {
  const candidates = [preferred, env.TREE_CODEX_BINARY, env.CODEX_BINARY, env.CODEX_CLI_PATH];
  for (const dir of (env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, process.platform === 'win32' ? 'codex.cmd' : 'codex'));
  candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const nvm = path.join(home, '.nvm/versions/node');
  if (fs.existsSync(nvm)) for (const version of fs.readdirSync(nvm).sort().reverse()) candidates.push(path.join(nvm, version, 'bin/codex'));
  return candidates.find(file => file && executable(file)) || 'codex';
}
export function readSettings(pluginRoot, { home = os.homedir(), env = process.env } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'settings.json'), 'utf8'));
  const dataDir = env.TREE_NATIVE_DATA_DIR || config.dataDir || path.join(home, 'Desktop', config.dataFolderName || 'Codex-Conversation-Tree', 'data/native');
  const prefsFile = path.join(dataDir, 'preferences.json');
  const prefs = fs.existsSync(prefsFile) ? JSON.parse(fs.readFileSync(prefsFile, 'utf8')) : {};
  return { dataDir, codexHome: env.TREE_NATIVE_CODEX_HOME || prefs.codexHome || config.codexHome || env.CODEX_HOME || path.join(home, '.codex'), codexBinary: findCodex({ home, env, preferred: prefs.codexBinary || config.codexBinary }), port: Number(env.TREE_NATIVE_PORT || prefs.port || config.port || 4321) };
}
