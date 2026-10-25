import { afterEach } from "vitest";
import { cleanupRenders } from "./render";
import "../i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Date-formatted share-card headings assert UTC; without this pin the suite
// fails on hosts east/west of UTC (e.g. EDT renders the previous day).
const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
if (proc?.env) proc.env.TZ = "UTC";

afterEach(() => {
  cleanupRenders();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-density");
});
