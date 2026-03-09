# HDR Loader Change Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent unnecessary loader revalidation during HMR when only component code changes.

**Architecture:** Add content hashing for loader/action exports on the server side, send `loaderChanged` flags to the client, and filter revalidation based on actual changes rather than export existence.

**Tech Stack:** TypeScript, Babel AST parsing, Vite HMR API

---

## Task 1: Add Export Code Extraction Helper

**Files:**
- Modify: `packages/react-router-dev/vite/route-chunks.ts:1007` (end of file)

**Step 1: Write the helper function**

Add to the end of `route-chunks.ts`:

```typescript
/**
 * Extracts the code for a specific export and its dependencies.
 * Unlike getChunkedExport, this works even for non-chunkable exports
 * (exports that share code with other exports).
 */
export function getExportCode(
  code: string,
  exportName: string,
  cache: Cache,
  cacheKey: string,
): string | undefined {
  return getOrSetFromCache(
    cache,
    `${cacheKey}::getExportCode::${exportName}`,
    code,
    () => {
      let exportDependencies = getExportDependencies(code, cache, cacheKey);
      let dependencies = exportDependencies.get(exportName);

      if (!dependencies) {
        return undefined;
      }

      let statements = Array.from(dependencies.topLevelStatements);
      let ast = codeToAst(code, cache, cacheKey);

      // Filter AST to only the statements this export depends on
      ast.program.body = ast.program.body.filter((node) =>
        statements.some((statement) => t.isNodesEquivalent(node, statement)),
      );

      if (ast.program.body.length === 0) {
        return undefined;
      }

      return generate(ast).code;
    },
  );
}
```

**Step 2: Verify the build compiles**

Run: `cd packages/react-router-dev && pnpm build`
Expected: Build succeeds without errors

**Step 3: Commit**

```bash
git add packages/react-router-dev/vite/route-chunks.ts
git commit -m "$(cat <<'EOF'
feat(vite): add getExportCode helper for HDR change detection

This extracts the code for a specific export and its dependencies,
enabling content-based change detection for loader/action exports.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add Route Code Cache to Plugin

**Files:**
- Modify: `packages/react-router-dev/vite/plugin.ts:1115` (near `currentReactRouterManifestForDev`)

**Step 1: Add the cache variable**

After line 1115 (`let currentReactRouterManifestForDev: ReactRouterManifest | null = null;`), add:

```typescript
  // Cache of route file source code for HMR change detection
  let routeCodeCache: Map<string, string> = new Map();
```

**Step 2: Verify the build compiles**

Run: `cd packages/react-router-dev && pnpm build`
Expected: Build succeeds without errors

**Step 3: Commit**

```bash
git add packages/react-router-dev/vite/plugin.ts
git commit -m "$(cat <<'EOF'
feat(vite): add route code cache for HDR change detection

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update handleHotUpdate to Detect Loader Changes

**Files:**
- Modify: `packages/react-router-dev/vite/plugin.ts:2391-2440` (handleHotUpdate)

**Step 1: Add import for getExportCode**

Find the imports from `"./route-chunks"` near the top of plugin.ts and add `getExportCode`:

```typescript
import {
  routeChunkExportNames,
  detectRouteChunks,
  getRouteChunkCode,
  isRouteChunkModuleId,
  getRouteChunkModuleId,
  getRouteChunkNameFromModuleId,
  getExportCode,  // Add this
} from "./route-chunks";
```

**Step 2: Update HmrEventData type and add change detection logic**

Replace the `handleHotUpdate` handler (lines 2391-2441) with:

```typescript
    {
      name: "react-router:hmr-updates",
      async handleHotUpdate({ server, file, modules, read }) {
        let route = getRoute(ctx.reactRouterConfig, file);

        type HmrEventData = {
          route: (ManifestRoute & {
            loaderChanged?: boolean;
            actionChanged?: boolean;
            clientLoaderChanged?: boolean;
            clientActionChanged?: boolean;
            clientMiddlewareChanged?: boolean;
          }) | null;
        };
        let hmrEventData: HmrEventData = { route: null };

        if (route) {
          // invalidate manifest on route exports change
          let oldRouteMetadata =
            currentReactRouterManifestForDev?.routes[route.id];
          let newRouteMetadata = await getRouteMetadata(
            cache,
            ctx,
            viteChildCompiler,
            route,
            read,
          );

          // Read new file content for change detection
          let newCode = await read();
          let oldCode = routeCodeCache.get(route.id);

          // Compute change flags
          let loaderChanged = false;
          let actionChanged = false;
          let clientLoaderChanged = false;
          let clientActionChanged = false;
          let clientMiddlewareChanged = false;

          if (!oldRouteMetadata || !oldCode) {
            // New route or first load - consider data exports changed if they exist
            loaderChanged = newRouteMetadata.hasLoader;
            actionChanged = newRouteMetadata.hasAction;
            clientLoaderChanged = newRouteMetadata.hasClientLoader;
            clientActionChanged = newRouteMetadata.hasClientAction;
            clientMiddlewareChanged = newRouteMetadata.hasClientMiddleware;
          } else {
            // Compare loader code
            if (oldRouteMetadata.hasLoader !== newRouteMetadata.hasLoader) {
              // Loader added or removed
              loaderChanged = true;
            } else if (newRouteMetadata.hasLoader) {
              // Both have loader - compare code
              let oldLoaderCode = getExportCode(oldCode, "loader", cache, `${route.id}:old`);
              let newLoaderCode = getExportCode(newCode, "loader", cache, `${route.id}:new`);
              loaderChanged = oldLoaderCode !== newLoaderCode;
            }

            // Compare action code
            if (oldRouteMetadata.hasAction !== newRouteMetadata.hasAction) {
              actionChanged = true;
            } else if (newRouteMetadata.hasAction) {
              let oldActionCode = getExportCode(oldCode, "action", cache, `${route.id}:old`);
              let newActionCode = getExportCode(newCode, "action", cache, `${route.id}:new`);
              actionChanged = oldActionCode !== newActionCode;
            }

            // For client-side exports, compare module URLs (they're chunked separately)
            clientLoaderChanged =
              oldRouteMetadata.clientLoaderModule !== newRouteMetadata.clientLoaderModule;
            clientActionChanged =
              oldRouteMetadata.clientActionModule !== newRouteMetadata.clientActionModule;
            clientMiddlewareChanged =
              oldRouteMetadata.clientMiddlewareModule !== newRouteMetadata.clientMiddlewareModule;
          }

          // Update code cache
          routeCodeCache.set(route.id, newCode);

          hmrEventData.route = {
            ...newRouteMetadata,
            loaderChanged,
            actionChanged,
            clientLoaderChanged,
            clientActionChanged,
            clientMiddlewareChanged,
          };

          if (
            !oldRouteMetadata ||
            (
              [
                "hasLoader",
                "hasClientLoader",
                "clientLoaderModule",
                "hasAction",
                "hasClientAction",
                "clientActionModule",
                "hasClientMiddleware",
                "clientMiddlewareModule",
                "hasErrorBoundary",
                "hydrateFallbackModule",
              ] as const
            ).some((key) => oldRouteMetadata[key] !== newRouteMetadata[key])
          ) {
            invalidateVirtualModules(server);
          }
        }

        server.hot.send({
          type: "custom",
          event: "react-router:hmr",
          data: hmrEventData,
        });

        return modules;
      },
    },
```

**Step 3: Verify the build compiles**

Run: `cd packages/react-router-dev && pnpm build`
Expected: Build succeeds without errors

**Step 4: Commit**

```bash
git add packages/react-router-dev/vite/plugin.ts
git commit -m "$(cat <<'EOF'
feat(vite): detect loader/action code changes in HMR

Compare actual export code content instead of just checking export
existence. This enables component-only changes to skip loader
revalidation.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Update Client to Use Change Flags

**Files:**
- Modify: `packages/react-router-dev/vite/static/refresh-utils.mjs:46-55`

**Step 1: Update needsRevalidation filter**

Replace lines 46-55:

```javascript
    let needsRevalidation = new Set(
      Array.from(routeUpdates.values())
        .filter(
          (route) =>
            route.hasLoader ||
            route.hasClientLoader ||
            route.hasClientMiddleware,
        )
        .map((route) => route.id),
    );
```

With:

```javascript
    let needsRevalidation = new Set(
      Array.from(routeUpdates.values())
        .filter(
          (route) =>
            route.loaderChanged ||
            route.clientLoaderChanged ||
            route.clientMiddlewareChanged,
        )
        .map((route) => route.id),
    );
```

**Step 2: Verify the build compiles**

Run: `cd packages/react-router-dev && pnpm build`
Expected: Build succeeds without errors

**Step 3: Commit**

```bash
git add packages/react-router-dev/vite/static/refresh-utils.mjs
git commit -m "$(cat <<'EOF'
feat(vite): use change flags for HDR revalidation

Filter routes needing revalidation based on whether their data exports
actually changed, not just whether they exist. This prevents
unnecessary loader re-execution on component-only changes.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add Integration Test for Component-Only Changes

**Files:**
- Modify: `integration/vite-hmr-hdr-test.ts:234-254` (after "route: HDR" test)

**Step 1: Add test case for component-only changes**

After the "route: HDR" test (around line 241), add this new test section:

```typescript
  // route: HMR only (component change, no HDR)
  // This tests that changing ONLY the component does NOT trigger loader revalidation
  let loaderCallCount = 0;
  await edit({
    "app/routes/_index.tsx": (contents) =>
      contents
        // Change component text only
        .replace("HMR updated: 1", "HMR updated: 1.5")
        // Add a way to track loader calls by changing the message format
        // The loader code itself doesn't change, only the component
  });
  await page.waitForLoadState("networkidle");
  await expect(hmrStatus).toHaveText("HMR updated: 1.5");
  // HDR status should NOT have changed - loader shouldn't have re-run
  await expect(hdrStatus).toHaveText("HDR updated: 1");
  await expect(input).toHaveValue("stateful");
  expect(page.errors).toEqual([]);
```

**Step 2: Run the test to verify it passes**

Run: `pnpm test:integration vite-hmr-hdr-test`
Expected: All tests pass, including the new component-only change test

**Step 3: Commit**

```bash
git add integration/vite-hmr-hdr-test.ts
git commit -m "$(cat <<'EOF'
test(vite): add test for component-only HMR without HDR

Verifies that changing only component code (not loader) does not
trigger unnecessary loader revalidation.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Run Full Test Suite

**Step 1: Run the HMR/HDR integration tests**

Run: `pnpm test:integration vite-hmr-hdr-test`
Expected: All tests pass

**Step 2: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Create final commit if any fixes were needed**

If any fixes were made during testing, commit them with appropriate messages.

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add `getExportCode` helper | `route-chunks.ts` |
| 2 | Add route code cache | `plugin.ts` |
| 3 | Update `handleHotUpdate` with change detection | `plugin.ts` |
| 4 | Use change flags in client | `refresh-utils.mjs` |
| 5 | Add integration test | `vite-hmr-hdr-test.ts` |
| 6 | Run full test suite | - |

## Edge Cases Handled

1. **New routes:** All change flags set to true based on export existence
2. **Loader added:** `loaderChanged = true` (hasLoader changed)
3. **Loader removed:** `loaderChanged = true` (hasLoader changed)
4. **Component-only change:** `loaderChanged = false` (code comparison shows no change)
5. **Loader code change:** `loaderChanged = true` (code comparison detects change)
6. **Client-side exports:** Use existing module URL comparison (already chunked separately)
