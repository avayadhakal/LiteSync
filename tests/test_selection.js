const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Extract the SelectionState and helper functions from static/js/app.js to ensure tests exercise the exact production implementation
const appJsContent = fs.readFileSync(path.join(__dirname, '../static/js/app.js'), 'utf8');
const scriptContext = `
${appJsContent.replace(/^[\s\S]*?class SelectionState/, 'class SelectionState').replace(/\/\/ --- Toast notifications[\s\S]*$/, '')}
module.exports = { SelectionState, normalizePath };
`;

// Evaluate in local scope
const exportsObj = {};
const moduleObj = { exports: exportsObj };
const runFn = new Function('module', 'exports', scriptContext);
runFn(moduleObj, exportsObj);
const { SelectionState, normalizePath } = moduleObj.exports;

console.log('Running LiteSync Selection Model JavaScript Test Suite...');

// 1. Select folder
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  assert.strictEqual(sel.isPathSelected('/movies'), true);
  assert.strictEqual(sel.size, 1);
  console.log('✓ Test 1: select folder passed');
})();

// 2. Child appears selected
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  assert.strictEqual(sel.isPathSelected('/movies/2026/movie.mkv'), true);
  assert.strictEqual(sel.isPathSelected('/movies/comedy/film.mp4'), true);
  console.log('✓ Test 2: child appears selected passed');
})();

// 3. Navigate into child & 4. Unselect one child
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026/movie.mkv');
  assert.strictEqual(sel.isPathSelected('/movies/2026/movie.mkv'), false);
  console.log('✓ Test 3 & 4: unselect one child passed');
})();

// 5. Siblings remain selected
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026/movie.mkv');
  assert.strictEqual(sel.isPathSelected('/movies/2026/other.mkv'), true);
  assert.strictEqual(sel.isPathSelected('/movies/2025/doc.mp4'), true);
  console.log('✓ Test 5: siblings remain selected passed');
})();

// 6. Reselect child
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026/movie.mkv');
  assert.strictEqual(sel.isPathSelected('/movies/2026/movie.mkv'), false);
  sel.select('/movies/2026/movie.mkv');
  assert.strictEqual(sel.isPathSelected('/movies/2026/movie.mkv'), true);
  assert.strictEqual(sel.exclude.size, 0);
  console.log('✓ Test 6: reselect child passed');
})();

// 7. Exclude nested directory
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026');
  assert.strictEqual(sel.isPathSelected('/movies/2026'), false);
  assert.strictEqual(sel.isPathSelected('/movies/2026/any_file.mkv'), false);
  assert.strictEqual(sel.isPathSelected('/movies/2025/file.mkv'), true);
  console.log('✓ Test 7: exclude nested directory passed');
})();

// 8. Select another parent
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.select('/tv_shows');
  assert.strictEqual(sel.isPathSelected('/movies/film.mkv'), true);
  assert.strictEqual(sel.isPathSelected('/tv_shows/s01/e01.mkv'), true);
  assert.strictEqual(sel.size, 2);
  console.log('✓ Test 8: select another parent passed');
})();

// 9. Overlapping parent selections
(() => {
  const sel = new SelectionState();
  sel.select('/movies/2026');
  assert.strictEqual(sel.size, 1);
  sel.select('/movies'); // covering parent
  assert.strictEqual(sel.isPathSelected('/movies/2026'), true);
  assert.strictEqual(sel.isPathSelected('/movies/2025'), true);
  // Redundant sub-include pruned
  assert.strictEqual(sel.include.has('/movies/2026'), false);
  assert.strictEqual(sel.size, 1);
  console.log('✓ Test 9: overlapping parent selections passed');
})();

// 10. Three-level re-inclusion: include parent, exclude child, re-include grandchild inside excluded child
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026');
  sel.select('/movies/2026/specific.mkv');

  // Longest-match verification
  assert.strictEqual(sel.isPathSelected('/movies/2026/specific.mkv'), true);
  assert.strictEqual(sel.isPathSelected('/movies/2026/other.mkv'), false);
  assert.strictEqual(sel.isPathSelected('/movies/2026/nested/file.mkv'), false);
  assert.strictEqual(sel.isPathSelected('/movies/2025/movie.mkv'), true);
  console.log('✓ Test 10: three-level re-inclusion longest-match passed');
})();

// 11. Re-including a directory prunes/adjusts nested exclude entries correctly
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026');
  sel.select('/movies/2026/sub');
  sel.unselect('/movies/2026/sub/nested.mkv');

  // Now re-include /movies/2026
  sel.select('/movies/2026');
  assert.strictEqual(sel.exclude.has('/movies/2026'), false);
  assert.strictEqual(sel.exclude.has('/movies/2026/sub/nested.mkv'), false);
  assert.strictEqual(sel.include.has('/movies/2026/sub'), false);
  assert.strictEqual(sel.isPathSelected('/movies/2026/sub/nested.mkv'), true);
  console.log('✓ Test 11: re-including directory prunes nested excludes passed');
})();

// 12. Rename selected item
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026/bad.mkv');

  sel.migratePath('/movies', '/media/films');
  assert.strictEqual(sel.isPathSelected('/media/films/2026/good.mkv'), true);
  assert.strictEqual(sel.isPathSelected('/media/films/2026/bad.mkv'), false);
  assert.strictEqual(sel.isPathSelected('/movies/2026/good.mkv'), false);
  console.log('✓ Test 12: rename selected item migration passed');
})();

// 13. Delete selected item
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026/bad.mkv');

  sel.deletePath('/movies/2026/bad.mkv');
  assert.strictEqual(sel.exclude.has('/movies/2026/bad.mkv'), false);

  sel.deletePath('/movies');
  assert.strictEqual(sel.include.size, 0);
  assert.strictEqual(sel.exclude.size, 0);
  console.log('✓ Test 13: delete selected item passed');
})();

// 14. Large conceptual subtree without materializing thousands of paths
(() => {
  const sel = new SelectionState();
  sel.select('/massive_mount');
  sel.unselect('/massive_mount/excluded_folder');

  const start = Date.now();
  for (let i = 0; i < 50000; i++) {
    sel.isPathSelected(`/massive_mount/sub_${i}/item_${i}.dat`);
  }
  const duration = Date.now() - start;
  assert.ok(duration < 1500, `Evaluation took too long: ${duration}ms`);
  assert.strictEqual(sel.include.size, 1);
  assert.strictEqual(sel.exclude.size, 1);
  console.log(`✓ Test 14: 50,000 in-memory evaluations completed in ${duration}ms without disk walk`);
})();

// 15. Transfer request generation: simple vs structured source
(() => {
  const sel = new SelectionState();
  sel.select('/docs');
  sel.select('/photos');
  sel.unselect('/photos/raw/large.dng');

  const sources = sel.toTransferSources();
  assert.deepStrictEqual(sources, [
    '/docs',
    { path: '/photos', excludes: ['raw/large.dng'] }
  ]);
  console.log('✓ Test 15: transfer request generation passed');
})();

// 16. Three-level re-inclusion transfer request generation
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026');
  sel.select('/movies/2026/specific.mkv');

  const sources = sel.toTransferSources();
  assert.deepStrictEqual(sources, [
    { path: '/movies', excludes: ['2026'] },
    '/movies/2026/specific.mkv'
  ]);
  console.log('✓ Test 16: three-level re-inclusion transfer generation passed');
})();

// Tri-State Indeterminate Verification
(() => {
  const sel = new SelectionState();
  sel.select('/movies');
  sel.unselect('/movies/2026/clip.mp4');

  assert.strictEqual(sel.isPathIndeterminate('/movies'), true); // selected with excluded child
  assert.strictEqual(sel.isPathIndeterminate('/movies/2026'), true); // not selected with selected siblings or selected with excluded child
  assert.strictEqual(sel.isPathIndeterminate('/movies/2025'), false); // fully selected directory

  console.log('✓ Tri-state checkbox state computation passed');
})();

console.log('\nAll JavaScript selection model unit tests passed successfully!');
