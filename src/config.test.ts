/**
 * Tests for the desktop-ipc host config seam (force-HTTP escape hatch).
 * Run with: npx vitest run libs/generic/desktop-ipc/src/config.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureDesktopIpc, isForceHttp, isRequireIpc } from './config';

const ENV_KEYS = ['DESKTOP_IPC_FORCE_HTTP', 'NEXT_PUBLIC_DESKTOP_IPC_FORCE_HTTP'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  // Reset host config + restore env so tests don't bleed.
  configureDesktopIpc({ forceHttp: undefined });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('isForceHttp — host config', () => {
  it('defaults to false with no config and no env', () => {
    expect(isForceHttp()).toBe(false);
  });

  it('honors a boolean true/false', () => {
    configureDesktopIpc({ forceHttp: true });
    expect(isForceHttp()).toBe(true);
    configureDesktopIpc({ forceHttp: false });
    expect(isForceHttp()).toBe(false);
  });

  it('honors a lazy resolver, re-evaluated on each check', () => {
    let flag = false;
    configureDesktopIpc({ forceHttp: () => flag });
    expect(isForceHttp()).toBe(false);
    flag = true;
    expect(isForceHttp()).toBe(true);
  });

  it('merges over a previous call rather than replacing the whole config', () => {
    configureDesktopIpc({ forceHttp: true });
    configureDesktopIpc({}); // no forceHttp key → previous value survives
    expect(isForceHttp()).toBe(true);
  });
});

describe('isForceHttp — generic env fallback', () => {
  it('reads DESKTOP_IPC_FORCE_HTTP=1 / =true as true', () => {
    process.env.DESKTOP_IPC_FORCE_HTTP = '1';
    expect(isForceHttp()).toBe(true);
    process.env.DESKTOP_IPC_FORCE_HTTP = 'true';
    expect(isForceHttp()).toBe(true);
  });

  it('treats other env values as false', () => {
    process.env.DESKTOP_IPC_FORCE_HTTP = '0';
    expect(isForceHttp()).toBe(false);
    process.env.DESKTOP_IPC_FORCE_HTTP = 'yes';
    expect(isForceHttp()).toBe(false);
  });

  it('falls back to the NEXT_PUBLIC_ prefixed var', () => {
    process.env.NEXT_PUBLIC_DESKTOP_IPC_FORCE_HTTP = '1';
    expect(isForceHttp()).toBe(true);
  });

  it('lets host config take precedence over env', () => {
    process.env.DESKTOP_IPC_FORCE_HTTP = '1';
    configureDesktopIpc({ forceHttp: false });
    expect(isForceHttp()).toBe(false);
  });
});

/**
 * REGRESSION: the escape hatch must survive a browser bundler.
 *
 * A bundler substitutes the TEXT `process.env` at build time — in the shipped
 * operator SPA every read compiles to the literal `{}`. So a `process.env`-only
 * hatch is not "usually fine, occasionally unset": it is UNREACHABLE in the one
 * surface the instruction is aimed at, and it fails silently because the
 * `typeof process !== 'undefined'` guard still passes. Measured against the live
 * bundle 2026-08-03 (EI-19420043903144442).
 *
 * These tests pin the bundler-proof source. They fail on the pre-fix code.
 */
describe('isForceHttp / isRequireIpc — bundler-proof runtime bag', () => {
  const REQUIRE_KEYS = ['DESKTOP_IPC_REQUIRE', 'NEXT_PUBLIC_DESKTOP_IPC_REQUIRE'] as const;
  let savedRequire: Record<string, string | undefined>;

  beforeEach(() => {
    savedRequire = {};
    for (const k of REQUIRE_KEYS) {
      savedRequire[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    delete (globalThis as { __DESKTOP_IPC_ENV__?: unknown }).__DESKTOP_IPC_ENV__;
    configureDesktopIpc({ requireIpc: undefined });
    for (const k of REQUIRE_KEYS) {
      if (savedRequire[k] === undefined) delete process.env[k];
      else process.env[k] = savedRequire[k];
    }
  });

  it('resolves force-HTTP from globalThis when process.env carries nothing', () => {
    // The `beforeEach` above cleared every DESKTOP_IPC_* key, so process.env is
    // as empty for these names as the bundle's `{}` is.
    expect(isForceHttp()).toBe(false);
    (globalThis as { __DESKTOP_IPC_ENV__?: Record<string, string> }).__DESKTOP_IPC_ENV__ = {
      DESKTOP_IPC_FORCE_HTTP: '1',
    };
    expect(isForceHttp()).toBe(true);
  });

  it('resolves the hatch with `process.env` literally replaced by {} — the shipped bundle', () => {
    const realProcess = globalThis.process;
    try {
      // Exactly what the bundle ships: `process` exists (so the typeof guard
      // passes) but `process.env` is an empty literal.
      (globalThis as { process?: unknown }).process = { env: {} };
      (globalThis as { __DESKTOP_IPC_ENV__?: Record<string, string> }).__DESKTOP_IPC_ENV__ = {
        DESKTOP_IPC_FORCE_HTTP: 'true',
      };
      expect(isForceHttp()).toBe(true);
    } finally {
      (globalThis as { process?: unknown }).process = realProcess;
    }
  });

  it('honors the DESKTOP_IPC_REQUIRE=0 opt-out through the bag', () => {
    expect(isRequireIpc()).toBe(true); // default
    (globalThis as { __DESKTOP_IPC_ENV__?: Record<string, string> }).__DESKTOP_IPC_ENV__ = {
      DESKTOP_IPC_REQUIRE: '0',
    };
    expect(isRequireIpc()).toBe(false);
  });

  it('still lets host config win over the bag', () => {
    (globalThis as { __DESKTOP_IPC_ENV__?: Record<string, string> }).__DESKTOP_IPC_ENV__ = {
      DESKTOP_IPC_FORCE_HTTP: '1',
    };
    configureDesktopIpc({ forceHttp: false });
    expect(isForceHttp()).toBe(false);
  });

  it('prefers the bag over a real process.env value', () => {
    process.env.DESKTOP_IPC_FORCE_HTTP = '0';
    (globalThis as { __DESKTOP_IPC_ENV__?: Record<string, string> }).__DESKTOP_IPC_ENV__ = {
      DESKTOP_IPC_FORCE_HTTP: '1',
    };
    expect(isForceHttp()).toBe(true);
  });
});
