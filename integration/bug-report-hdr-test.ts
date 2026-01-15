import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import getPort from "get-port";
import dedent from "dedent";

import { test } from "./helpers/fixtures";
import * as Stream from "./helpers/stream";

const tsx = dedent;

////////////////////////////////////////////////////////////////////////////////
// 👋 Hola! I'm here to help you write a great bug report for HMR/HDR issues.
//
// This test file demonstrates that component-only changes trigger unnecessary
// HDR (Hot Data Revalidation), causing loaders to re-run even when only React
// component code changed.
//
// To run these tests:
//
//    ```
//    pnpm install && pnpm build
//    pnpm playwright:integration bug-report-hdr --project chromium
//    ```
//
// Both tests below are EXPECTED TO FAIL, demonstrating the bug.
////////////////////////////////////////////////////////////////////////////////

test.describe("Bug Report: Component-only changes trigger unnecessary HDR", () => {
  test.describe("Test 1: Same-file component change", () => {
    test.use({
      template: "vite-6-template",
      files: {
        "app/routes/_index.tsx": tsx`
          import { useLoaderData } from "react-router";

          export function loader() {
            // Using Date.now() to detect if loader re-runs
            return { timestamp: Date.now() };
          }

          export default function IndexRoute() {
            const { timestamp } = useLoaderData<typeof loader>();
            return (
              <div id="index">
                <p data-timestamp>Loader timestamp: {timestamp}</p>
                <p data-component>Component text v1</p>
              </div>
            );
          }
        `,
      },
    });

    test("editing component code in route file should NOT trigger HDR when loader unchanged", async ({
      page,
      edit,
      $,
    }) => {
      ////////////////////////////////////////////////////////////////////////////
      // BUG: When editing ONLY the component JSX in a route file (not the loader),
      // the loader re-runs unnecessarily. The loader code itself didn't change,
      // so HDR should not trigger - only HMR should update the component.
      ////////////////////////////////////////////////////////////////////////////

      const port = await getPort();
      const url = `http://localhost:${port}`;

      const dev = $(`pnpm dev --port ${port}`);
      await Stream.match(dev.stdout, url);

      // Initial page load
      await page.goto(url, { waitUntil: "networkidle" });
      await expect(page.locator("#index [data-component]")).toHaveText(
        "Component text v1"
      );

      // Capture the initial loader timestamp
      const timestampBefore = await page
        .locator("#index [data-timestamp]")
        .textContent();
      expect(timestampBefore).toContain("Loader timestamp:");

      // Edit ONLY the component JSX (not the loader function)
      await edit({
        "app/routes/_index.tsx": (contents) =>
          contents.replace("Component text v1", "Component text v2"),
      });
      await page.waitForLoadState("networkidle");

      // Verify HMR worked - component should update
      await expect(page.locator("#index [data-component]")).toHaveText(
        "Component text v2"
      );

      // BUG: The loader should NOT have re-run since we only changed component JSX
      // This assertion FAILS because the timestamp changes (loader re-ran)
      const timestampAfter = await page
        .locator("#index [data-timestamp]")
        .textContent();
      expect(timestampAfter).toBe(timestampBefore);

      expect(page.errors).toEqual([]);
    });
  });

  test.describe("Test 2: Cross-file component change", () => {
    test.use({
      template: "vite-6-template",
      files: {
        "app/component.tsx": tsx`
          export function MyComponent() {
            return <p data-component>External component v1</p>;
          }
        `,
        "app/routes/_index.tsx": tsx`
          import { useLoaderData } from "react-router";
          import { MyComponent } from "../component";

          export function loader() {
            // Using Date.now() to detect if loader re-runs
            return { timestamp: Date.now() };
          }

          export default function IndexRoute() {
            const { timestamp } = useLoaderData<typeof loader>();
            return (
              <div id="index">
                <p data-timestamp>Loader timestamp: {timestamp}</p>
                <MyComponent />
              </div>
            );
          }
        `,
      },
    });

    test("editing external component file should NOT trigger HDR", async ({
      page,
      edit,
      $,
    }) => {
      ////////////////////////////////////////////////////////////////////////////
      // BUG: When editing app/component.tsx (an external component file), the
      // loader re-runs unnecessarily. The component is NOT used by the loader,
      // only by the React component, so HDR should not trigger.
      ////////////////////////////////////////////////////////////////////////////

      const port = await getPort();
      const url = `http://localhost:${port}`;

      const dev = $(`pnpm dev --port ${port}`);
      await Stream.match(dev.stdout, url);

      // Initial page load
      await page.goto(url, { waitUntil: "networkidle" });
      await expect(page.locator("#index [data-component]")).toHaveText(
        "External component v1"
      );

      // Capture the initial loader timestamp
      const timestampBefore = await page
        .locator("#index [data-timestamp]")
        .textContent();
      expect(timestampBefore).toContain("Loader timestamp:");

      // Edit ONLY the external component file (not the route, not the loader)
      await edit({
        "app/component.tsx": (contents) =>
          contents.replace("External component v1", "External component v2"),
      });
      await page.waitForLoadState("networkidle");

      // Verify HMR worked - component should update
      await expect(page.locator("#index [data-component]")).toHaveText(
        "External component v2"
      );

      // BUG: The loader should NOT have re-run since we only changed component code
      // This assertion FAILS because the timestamp changes (loader re-ran)
      const timestampAfter = await page
        .locator("#index [data-timestamp]")
        .textContent();
      expect(timestampAfter).toBe(timestampBefore);

      expect(page.errors).toEqual([]);
    });
  });
});

////////////////////////////////////////////////////////////////////////////////
// ROOT CAUSE ANALYSIS:
//
// TEST 1 (Same-file): The server computes `loaderChanged` by comparing loader
// code before/after, but this flag is not being used correctly to prevent HDR.
//
// TEST 2 (Cross-file): In `refresh-utils.mjs`, `revalidate()` is called
// unconditionally for ALL HMR updates. This is intentional to support non-route
// loader dependencies, but the system cannot distinguish between:
//   1. Loader dependencies → should trigger HDR
//   2. Component dependencies → should NOT trigger HDR
//
// EXPECTED BEHAVIOR:
// - Editing component code should only trigger HMR (React Fast Refresh)
// - Loaders should only re-run when loader code or loader dependencies change
//
// ACTUAL BEHAVIOR:
// - Any change triggers HDR, even component-only changes
// - Loaders re-run unnecessarily, wasting resources
////////////////////////////////////////////////////////////////////////////////
