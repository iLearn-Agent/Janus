#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { publishAgentBundleRelease } from '../src/cloud/releasePublisher.js';

const cloudHome = process.env.JANUS_CLOUD_HOME || (fs.existsSync('/path/to/janus-cloud') ? '/path/to/janus-cloud' : path.join(process.cwd(), 'cloud-workspace'));
const serverRoot = path.resolve(process.env.JANUS_SERVER_EVOLUTION_HOME || path.join(cloudHome, 'evolution-workspace'));
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const serverSkillsRoot = path.join(serverRoot, 'skills');
const result = await publishAgentBundleRelease({
  cloudHome,
  departmentsRoot: path.join(serverRoot, 'departments'),
  skillsRoot: fs.existsSync(serverSkillsRoot) ? serverSkillsRoot : path.join(process.cwd(), 'assets', 'skills'),
  appVersion: packageJson.version,
  sourceMaintenanceRunId: process.env.JANUS_SOURCE_MAINTENANCE_RUN_ID || '',
  changeSummary: process.env.JANUS_AGENT_RELEASE_SUMMARY || 'Signed server-authoritative Agent laboratory release.',
  channel: process.env.JANUS_RELEASE_CHANNEL || 'dev',
  promoteStable: !['0', 'false', 'no', 'off'].includes(String(process.env.JANUS_EVOLUTION_AUTO_PROMOTE_STABLE || '1').toLowerCase()),
});
process.stdout.write(`${JSON.stringify({
  status: result.status,
  version: result.manifest?.version || result.stableManifest?.version || '',
  bundleId: result.bundle?.bundleId || '',
  signingKeyId: result.bundle?.signingKeyId || '',
  releaseId: result.manifest?.id || '',
  stableReleaseId: result.stableManifest?.id || '',
}, null, 2)}\n`);
