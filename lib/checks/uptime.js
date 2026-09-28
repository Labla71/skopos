// Example check: time since the last boot. A recent reboot is a finding.
import { uptime } from 'node:os';

export default {
  name: 'uptime',
  required: [],
  optional: ['warn_below_seconds'],

  validate(params) {
    const w = params.warn_below_seconds;
    if (w !== undefined && !(typeof w === 'number' && Number.isFinite(w) && w >= 0)) {
      return ['warn_below_seconds must be a number ≥ 0'];
    }
    return [];
  },

  async measure(params) {
    const seconds = Math.floor(uptime());
    const limit = params.warn_below_seconds;
    if (limit !== undefined && seconds < limit) {
      return [{ value: seconds, unit: 's', status: 'warn', reason: `uptime below ${limit} s (reboot?)` }];
    }
    return [{ value: seconds, unit: 's', status: 'ok' }];
  },
};
