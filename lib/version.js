'use strict';

function supportedVersions() {
  const minecraftData = require('minecraft-data');
  const minecraftProtocol = require('minecraft-protocol');
  const dataVersions = new Set(
    (minecraftData.versions?.pc || [])
      .map(version => version.minecraftVersion)
  );
  const protocolVersions = new Set(minecraftProtocol.supportedVersions || []);
  return [...dataVersions].filter(version => protocolVersions.has(version));
}

function resolveBotVersion(config = {}, env = process.env, supported = supportedVersions()) {
  const configured = String(config.server?.version || '').trim();
  if (!configured) return { version: false, requested: '', fallback: false };

  const supportedSet = new Set(supported);
  if (supportedSet.has(configured)) {
    return { version: configured, requested: configured, fallback: false };
  }

  const fallback = String(
    env.MINECRAFT_VERSION_FALLBACK ||
    config.server?.['proxy-version-fallback'] ||
    ''
  ).trim();

  if (fallback && supportedSet.has(fallback)) {
    return { version: fallback, requested: configured, fallback: true };
  }

  const supportedList = [...supportedSet].join(', ');
  const error = new Error(
    `Minecraft version ${configured} is not supported by the installed protocol stack. ` +
    `Supported versions: ${supportedList || 'none'}. ` +
    'Use a server version supported by this stack, or use a protocol-translating proxy that accepts a supported client version; changing the client version alone does not translate the server protocol.'
  );
  error.code = 'ERR_UNSUPPORTED_MINECRAFT_VERSION';
  throw error;
}

module.exports = { resolveBotVersion, supportedVersions };
