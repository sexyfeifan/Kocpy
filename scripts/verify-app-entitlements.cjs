// Read the actual signed application, never the requested signing-input plist.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const plist = require('plist');
// Use plist's locked XML parser dependency, including with non-hoisted installs.
const { DOMParser } = createRequire(require.resolve('plist/package.json'))('@xmldom/xmldom');

const REQUIRED_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.disable-library-validation',
]);
const commandOptions = { encoding: 'utf8', stdio: 'pipe', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 };

function elementChildren(node) {
  const children = [];
  for (const child of Array.from(node.childNodes || [])) {
    if (child.nodeType === 1) children.push(child);
    else if (child.nodeType === 8) continue; // XML comments are not plist values.
    else assert(child.nodeType === 3 && !child.nodeValue.trim(), 'Unexpected content in entitlement plist structure');
  }
  return children;
}

function parseRequiredEntitlements(xml) {
  assert(typeof xml === 'string' && xml.length > 0 && Buffer.byteLength(xml) <= commandOptions.maxBuffer,
    'Missing or oversized signed entitlement plist');
  const failXml = () => { throw new Error('Malformed signed entitlement XML'); };
  const document = new DOMParser({ errorHandler: { warning: failXml, error: failXml, fatalError: failXml } })
    .parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  assert(root?.tagName === 'plist' && !root.namespaceURI, 'Signed entitlements must be an XML plist');
  const roots = elementChildren(root);
  assert(roots.length === 1 && roots[0].tagName === 'dict', 'Signed entitlements must contain one root dictionary');

  // plist.parse (and plutil's JSON conversion) can collapse duplicate keys.
  // Inspect the parsed XML tree first, including entity-decoded key names.
  for (const node of Array.from(root.getElementsByTagName('*'))) {
    assert(!node.namespaceURI && node.attributes.length === 0, 'Unexpected entitlement plist attributes');
    if (node.tagName === 'dict') {
      const children = elementChildren(node), keys = new Set();
      assert(children.length % 2 === 0, 'Unpaired entitlement plist key');
      for (let index = 0; index < children.length; index += 2) {
        const key = children[index];
        assert(key.tagName === 'key' && children[index + 1].tagName !== 'key', 'Invalid entitlement plist dictionary');
        assert(Array.from(key.childNodes).every((child) => child.nodeType === 3 || child.nodeType === 4), 'Invalid entitlement plist key');
        assert(!keys.has(key.textContent), 'Duplicate entitlement plist key');
        keys.add(key.textContent);
      }
    } else if (node.tagName === 'true' || node.tagName === 'false') {
      assert(elementChildren(node).length === 0, 'Entitlement booleans must be empty plist values');
    }
  }

  const entitlements = plist.parse(xml);
  assert(entitlements && typeof entitlements === 'object' && !Array.isArray(entitlements), 'Signed entitlements must be a dictionary');
  for (const key of REQUIRED_ENTITLEMENTS) {
    assert(Object.prototype.hasOwnProperty.call(entitlements, key) && entitlements[key] === true,
      `Signed entitlement ${key} must be boolean true`);
  }
  return entitlements;
}

function verifyAppEntitlements(appPath, dependencies = {}) {
  assert(typeof appPath === 'string' && appPath.endsWith('.app'), 'Provide the exact signed .app bundle');
  const app = path.resolve(appPath), run = dependencies.execFileSync || execFileSync;
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], commandOptions);
  // New codesign versions otherwise emit a textual description instead of XML.
  const xml = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', app], commandOptions);
  return parseRequiredEntitlements(xml);
}

module.exports = { REQUIRED_ENTITLEMENTS, parseRequiredEntitlements, verifyAppEntitlements };
if (require.main === module) {
  try {
    assert(process.argv.length === 3, 'Usage: node scripts/verify-app-entitlements.cjs /path/to/Kocpy.app');
    verifyAppEntitlements(process.argv[2]);
    console.log('Signed application structure and required boolean entitlements verified.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
