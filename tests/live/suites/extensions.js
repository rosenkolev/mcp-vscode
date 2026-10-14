'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { publisher, name } = require('../../../package.json');

const SELF_ID = `${publisher}.${name}`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Small Marketplace extension for the install round trip; it goes into the run's own extensions folder.
 * Microsoft's own publisher is trusted without asking, so the install needs no confirmation.
 */
const MARKETPLACE_EXTENSION = 'ms-vscode.hexeditor';
const withNetwork = process.env.LIVE_TESTS_NETWORK === '1';

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('extensions', { timeout: 120000 }, () => {
    it('lists this extension as active, and only what this window loaded', async () => {
      const text = await live.client.ok('list_extensions');
      assert.match(text, new RegExp(`${escapeRegExp(SELF_ID)}@[\\d.]+ - active - MCP VS Code`));
      // Run from source with no installed extension, the extensions folder is unknown: no guessing at disabled ones.
      assert.match(text, /Disabled extensions are not listed: .*extensions folder is unknown/);
    });

    it('validates ids and paths, and protects itself', async () => {
      assert.match(await live.client.fails('install_extension', { id: 'not an id' }), /not an extension id/);
      assert.match(await live.client.fails('install_extension', { id: 'a/missing.vsix' }), /No file at/);
      assert.match(await live.client.fails('uninstall_extension', { id: SELF_ID }), /cannot uninstall itself/);
    });

    it('installs and uninstalls from the Marketplace', { skip: !withNetwork && 'set LIVE_TESTS_NETWORK=1' }, async (t) => {
      const installed = await live.client.ok('install_extension', { id: MARKETPLACE_EXTENSION, timeout_seconds: 20 });
      // A fresh profile may ask to trust the publisher; the tool must then return instead of waiting forever.
      if (/still waiting after 20s/.test(installed)) {
        t.skip('VS Code asked to trust the publisher, so only the timeout reply was checked.');
        return;
      }
      assert.match(installed, /^Installed ms-vscode\.hexeditor@/);
      assert.match(await live.client.ok('list_extensions', { filter: 'hexeditor' }), / - (active|inactive) - /);
      assert.match(await live.client.ok('uninstall_extension', { id: MARKETPLACE_EXTENSION }), /Uninstalled/);
      // A loaded extension shows as uninstalled until reload; one that never loaded is gone at once.
      assert.match(await live.client.ok('list_extensions', { filter: 'hexeditor' }), / - uninstalled - |No matching extensions/);
    });
  });
