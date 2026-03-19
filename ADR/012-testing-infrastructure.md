# ADR-012: Testing Infrastructure

## Status
Accepted

## Context

ADR-011 introduced a clean `BrokerAdapter` interface, normalized types, and well-defined module boundaries across `lib/brokers/` and `lib/market-data/`. These are the highest-value modules to test first: pure mapping functions, adapter behaviour under mocked HTTP, caching correctness, and tool capability filtering.

The project had zero test infrastructure prior to this. Starting from scratch meant choosing a test runner, establishing mock patterns for the specific module shapes in use, and deciding how to handle modules with module-level caches.

---

## Decisions

### 1. Vitest over Jest

**Chosen: Vitest**

The project uses `"module": "NodeNext"` with `.js` import extensions throughout. Jest requires either `ts-jest` + `moduleNameMapper` configuration to translate `.js` → `.ts`, or `babel-jest`, both of which add non-trivial setup. Vitest uses esbuild to transform TypeScript and resolves `.js` extensions to `.ts` source files automatically — zero extra configuration needed.

Other factors:
- `vi.mock()` / `vi.fn()` / `vi.spyOn()` cover all mocking needs without additional libraries
- Jest-compatible API means familiarity carries over
- Native ESM support; no `--experimental-vm-modules` flag needed

**Rejected alternatives:**
- **Jest + ts-jest:** Works but requires `moduleNameMapper` config to handle `.js` → `.ts` resolution with NodeNext; adds a `babel`/`ts-jest` dependency
- **Mocha + ts-node:** Good ESM support but no built-in mocking; would require Sinon or similar

### 2. Constructor mock pattern: regular function, not arrow

When mocking a class constructor with `vi.mock`, the factory function passed to `mockImplementation` (or `vi.fn(factory)`) **must be a regular function, not an arrow function**:

```typescript
// ✓ Correct — regular function can be called with `new`
vi.mock('./client.js', () => ({
  DhanClient: vi.fn(function (this: any) {
    this.getQuote = vi.fn();
    this.placeOrder = vi.fn();
    // ...
  }),
}));

// ✗ Wrong — arrow functions have no [[Construct]], throws TypeError at runtime
vi.mock('./client.js', () => ({
  DhanClient: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn(),
  })),
}));
```

**Why:** Arrow functions do not have a `[[Construct]]` internal method. When the subject under test calls `new DhanClient(...)`, Vitest forwards the `new` call to the mock factory. If the factory is an arrow function, JavaScript throws `TypeError: ... is not a constructor` at runtime.

Using `function(this: any) { this.method = vi.fn() }` assigns methods directly to the instance (`this`), which is what `new` returns. Each `new DhanClient()` call produces a fresh set of `vi.fn()` instances.

### 3. Module-level cache isolation: unique index names per test

`lib/market-data/nse.ts` and `lib/brokers/dhan/instruments.ts` each hold a module-level cache (`Map` or object) that persists for the lifetime of the test file's module instance. `vi.clearAllMocks()` in `beforeEach` resets mock function call counts but **does not clear module-level data structures**.

Two strategies were considered:

**Option A — `vi.resetModules()` + dynamic imports per test:**
```typescript
beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../nse.js');
  getIndexConstituents = mod.getIndexConstituents;
});
```
Gives perfect isolation but is verbose and requires dynamic imports in every test.

**Option B — Unique index name per test (chosen):**
Each test uses a distinct index name that no other test in the file has touched. Because the cache is keyed by normalised index name, tests never share cache entries. The caching behaviour itself is verified by calling the same index name twice *within a single test*.

```typescript
it('caches on second call', async () => {
  // 'NIFTY100' has not been fetched by any prior test in this file
  await getIndexConstituents('NIFTY100');
  await getIndexConstituents('NIFTY100');
  expect(mockFetch).toHaveBeenCalledTimes(1); // ✓
});
```

Option B is simpler and sufficient. The downside (tests must coordinate index names) is manageable at this scale.

### 4. `@internal` exports for pure helper functions

Two private helpers in `dhan/index.ts` — `toDhanInterval` and `parseDhanOrderStatus` — are pure functions with no side effects and complete, self-contained logic worth testing directly. They were made `export` with an `// @internal` comment rather than tested indirectly through adapter methods:

```typescript
// @internal — exported for unit testing only
export function toDhanInterval(interval: CandleInterval): "1" | "5" | "15" | "25" | "60" | "D" { ... }

// @internal — exported for unit testing only
export function parseDhanOrderStatus(dhanStatus: string): OrderStatus { ... }
```

**Rationale:** Testing these through `adapter.getHistory()` or `adapter.getOrders()` would require constructing full HTTP mock responses just to observe an interval mapping or status normalisation. Direct export makes the tests simpler and the failure messages more precise. The `@internal` comment signals that nothing outside of tests should import these.

### 5. Test layout mirrors source layout under `__tests__/`

```
src/lib/
  brokers/
    __tests__/
      errors.test.ts
      factory.test.ts
      dhan/
        mapping.test.ts
        adapter.test.ts
        instruments.test.ts
        order-sync.test.ts
  market-data/
    __tests__/
      nse.test.ts
  __tests__/
    tools-capabilities.test.ts
```

`__tests__/` directories sit alongside the modules they test. Relative import paths stay short (usually `../../module.js`). Vitest's `include: ['src/**/*.test.ts']` picks them all up.

---

## Coverage Scope

Coverage is intentionally scoped to the highest-value, most-testable modules:

```typescript
coverage: {
  include: ['src/lib/brokers/**', 'src/lib/market-data/**', 'src/lib/tools.ts'],
}
```

Excluded from coverage targets: routes, server startup, heartbeat runner, scheduler runner. These are integration-heavy — they depend on WebSocket sessions, file I/O, and live broker connections. Unit coverage of them would require substantially more mocking infrastructure for limited benefit.

---

## What Is Not Tested Here

- **Real HTTP requests** — all network calls are mocked. The instrument CSV fetch, niftyindices.com fetch, and Dhan REST API are never called in tests.
- **`DhanClient` internals** — retry logic, auth header construction, 429 handling in `client.ts` are not covered. These are good candidates for a future `client.test.ts`.
- **Heartbeat / scheduler integration** — covered by manual testing and future integration test work.

---

## Consequences

- `npm test` runs the full suite in ~200ms with no external dependencies or env vars required.
- Adding tests for a new broker adapter means: create `lib/brokers/{name}/__tests__/`, mock `{name}/client.js` with the regular-function constructor pattern, and follow the `@internal` export pattern for any pure mappers.
- The `@internal` export convention is a soft boundary — TypeScript does not enforce it. A future linting rule (e.g., ESLint `no-restricted-imports`) could enforce it if needed.
