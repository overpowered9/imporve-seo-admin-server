import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentV3Config, DEFAULT_TARGET_CALIBRATION, targetCalibration } from './content-v3.config.js';

test('A1: word-target calibration defaults to the approved values and reads CONTENT_V3_TARGET_CALIBRATION_JSON', () => {
  assert.deepEqual(targetCalibration({}), { small: 1.0, medium: 1.3, large: 1.6 });
  assert.deepEqual(contentV3Config({}).targetCalibration, DEFAULT_TARGET_CALIBRATION);
  assert.deepEqual(targetCalibration({ CONTENT_V3_TARGET_CALIBRATION_JSON: '{"medium":1.45}' }), { small: 1.0, medium: 1.45, large: 1.6 });
  // Out of range (0.5–2.5), not a number, or unreadable JSON: the default for that size.
  assert.deepEqual(targetCalibration({ CONTENT_V3_TARGET_CALIBRATION_JSON: '{"small":9,"medium":"x","large":0.2}' }), { ...DEFAULT_TARGET_CALIBRATION });
  assert.deepEqual(targetCalibration({ CONTENT_V3_TARGET_CALIBRATION_JSON: 'not json' }), { ...DEFAULT_TARGET_CALIBRATION });
});
