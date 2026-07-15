import { describe, expect, it } from 'vitest';
import { createStarterConfig } from '../src/core/config.js';
import {
  assertLaunchdTimezone,
  generateLaunchdPlist,
  labelForJob,
} from '../src/plugins/schedulers/launchd.js';

describe('launchd scheduler', () => {
  it('generates a plist with only safe runtime arguments', () => {
    const job = createStarterConfig().jobs['daily-report'];
    expect(job).toBeDefined();
    if (!job) return;

    const plist = generateLaunchdPlist({
      jobName: 'daily-report',
      job,
      cliPath: '/opt/internflow/dist/cli.js',
      configPath: '/Users/example/.config/internflow/config.yaml',
      timezone: 'Asia/Shanghai',
    });

    expect(plist).toContain(labelForJob('daily-report'));
    expect(plist).toContain('<key>Weekday</key><integer>2</integer>');
    expect(plist).toContain('<key>Hour</key><integer>23</integer>');
    expect(plist).toContain('<key>Minute</key><integer>30</integer>');
    expect(plist).toContain('<string>--scheduled</string>');
    expect(plist).not.toContain('document');
    expect(plist).not.toContain('model');
  });

  it('adds a stable hash so normalized job names cannot collide', () => {
    const spaced = labelForJob('daily report');
    const dashed = labelForJob('daily-report');

    expect(spaced).toBe(labelForJob('daily report'));
    expect(spaced).toMatch(/^dev\.internflow\.job\.daily-report-[a-f0-9]{8}$/);
    expect(dashed).toMatch(/^dev\.internflow\.job\.daily-report-[a-f0-9]{8}$/);
    expect(spaced).not.toBe(dashed);
  });

  it('accepts the configured timezone when it matches the system timezone', () => {
    expect(() => assertLaunchdTimezone('Asia/Shanghai', 'Asia/Shanghai')).not.toThrow();
  });

  it('rejects installation when launchd would use a different timezone', () => {
    expect(() => assertLaunchdTimezone('Asia/Shanghai', 'America/Los_Angeles')).toThrow(
      /config timezone "Asia\/Shanghai" does not match the macOS system timezone "America\/Los_Angeles"/,
    );
  });
});
