const Module = require('node:module');
const { join, resolve } = require('node:path');
const { emitter } = require('./trace.cjs');
const backend = resolve(__dirname, '../../apps/backend');
const setup = join(__dirname, 'setup.cjs');
const emit = emitter('preload.jsonl');
const original = Module._load;
Module._load = function (request, parent, isMain) {
  const value = Reflect.apply(original, this, arguments);
  if (request === join(backend, 'jest.config.js')) {
    value.setupFilesAfterEnv = [...(value.setupFilesAfterEnv ?? []).filter(file => file !== setup), setup];
    emit({ event: 'config', testTimeout: value.testTimeout ?? 5000, maxWorkers: value.maxWorkers,
      observerCount: value.setupFilesAfterEnv.filter(file => file === setup).length });
  }
  return value;
};
