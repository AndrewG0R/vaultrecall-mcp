#!/usr/bin/env node

// Deliberately plain, old-style CommonJS (var, string concatenation, no arrow functions) so this
// version gate itself parses and runs on virtually any Node release — a syntax error in this file
// would produce a cryptic, unhelpful crash instead of the clear message below. The actual server
// (dist/index.js) is real ESM and can freely use modern syntax; it's only reached via dynamic
// import() after the version check passes.

var MIN_NODE_MAJOR = 18;
var nodeVersion = process.versions.node;
var major = parseInt(nodeVersion.split(".")[0], 10);

if (major < MIN_NODE_MAJOR) {
  console.error(
    "second-brain-mcp requires Node.js " + MIN_NODE_MAJOR + "+ (you're running " + nodeVersion + ").\n" +
    "Please upgrade Node.js: https://nodejs.org/"
  );
  process.exit(1);
}

import("../dist/index.js").catch(function (err) {
  console.error("Fatal error starting second-brain-mcp:", err);
  process.exit(1);
});
