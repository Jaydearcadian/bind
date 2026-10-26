/*
 * zod 4 probes `new Function("")` when a schema is built, to decide whether to compile validators. Under script-src 'self'
 * that probe is a CSP violation even though it is caught (ADR 0089). This module must be imported BEFORE anything that builds a
 * zod schema (ES modules run imports in order), so it switches compilation off first. The SDK's schemas are tiny.
 */
import { z } from "zod";

z.config({ jitless: true });
