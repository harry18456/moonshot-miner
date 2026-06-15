// Minimal dependency-free test runner. Each test module exports a function
// (sync or async) that throws/rejects on failure. Run with `npm test`.
const groups = [
    ['hash-utils', require('./hash-utils.test.js')],
    ['config-validation', require('./config-validation.test.js')],
    ['reconnect', require('./reconnect.test.js')],
    ['mining', require('./mining.test.js')],
];

(async () => {
    let failed = 0;
    for (const [name, fn] of groups) {
        try {
            await fn();
            console.log(`PASS ${name}`);
        } catch (err) {
            failed++;
            console.error(`FAIL ${name}: ${err.message}`);
            console.error(err.stack);
        }
    }

    if (failed) {
        console.error(`\n${failed} test group(s) failed`);
        process.exit(1);
    }
    console.log('\nAll test groups passed');
})();
