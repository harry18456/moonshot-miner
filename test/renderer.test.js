const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = async function run() {
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set();
            elements.set(id, {
                value: '', style: {}, events: {},
                classList: {
                    add: value => classes.add(value), remove: value => classes.delete(value),
                    contains: value => classes.has(value), toggle() {},
                },
                addEventListener(event, callback) { this.events[event] = callback; },
            });
        }
        return elements.get(id);
    }
    let init, status, stops = 0;
    const timers = new Set();
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8'), {
        console,
        document: {
            getElementById: element, querySelector: element,
            addEventListener: (event, callback) => { init = callback; },
        },
        window: { api: {
            getConfig: async () => ({ intensity: 0 }), getAppVersion: async () => 'test',
            onStatusUpdate: callback => { status = callback; }, onWorkerMessage() {},
            stopMiner: () => { stops++; }, resizeMe() {},
        } },
        setTimeout: callback => { timers.add(callback); return callback; },
        clearTimeout: callback => timers.delete(callback),
    });
    await init();
    assert.strictEqual(element('intensity').value, 0, 'reload preserves intensity zero');
    timers.clear();
    const label = element('status-text');
    const button = element('toggle-mining-btn');
    status({ state: 'SUBMITTED', message: 'Awaiting response' });
    assert.strictEqual(label.innerText, 'SUBMITTED');
    status({ state: 'ACCEPTED', message: 'Share accepted' });
    assert.strictEqual(label.innerText, 'ACCEPTED');
    status({ state: 'REJECTED', message: 'Low difficulty share' });
    assert.strictEqual(label.innerText, 'REJECTED');
    assert.strictEqual(button.innerText, 'Stop', 'a rejected share does not stop the worker');
    button.events.click();
    assert.strictEqual(stops, 1);
    status({ state: 'CONNECTING' });
    assert.strictEqual(timers.size, 0, 'an old share timer cannot overwrite reconnect status');
    assert.strictEqual(label.innerText, 'CONNECTING');
    status({ state: 'ERROR', active: true, message: 'Authorization failed' });
    button.events.click();
    assert.strictEqual(stops, 2, 'a live worker can be stopped after an error');
    status({ state: 'IDLE' });
    assert.strictEqual(button.innerText, 'Start Mining');
    console.log('  renderer: intensity zero, distinct share states and worker stop controls');
};
