/**
 * GET/PUT/DELETE /api/sparks/:id/gpu-clock. Registered after the auth and
 * Host/Origin middleware, so a token (when SPARKDASH_TOKEN is set) is required
 * exactly as for power actions. Changing a cap uses the destructive limiter.
 */
export function registerGpuClockRoutes(app, { manager, registry, recordEvent, allowRead, allowChange, rejectLimited }) {
  const handle = (fn) => async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      await fn(spark, req, res);
    } catch (err) {
      // Errors from the manager carry a status and a curated message; anything else stays generic.
      const known = Number.isInteger(err?.status);
      res.status(known ? err.status : 500).json({ error: known ? err.message : "GPU clock action failed", code: err?.code });
    }
  };

  app.get(
    "/api/sparks/:id/gpu-clock",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(await manager.status(spark));
    })
  );

  app.put(
    "/api/sparks/:id/gpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many GPU clock changes, try again in a minute");
      const out = await manager.apply(spark, req.body);
      recordEvent({
        type: "gpu.clock.set",
        severity: "info",
        sparkId: spark.id,
        message: `GPU clock capped at ${out.capMHz} MHz${out.persist ? " (kept after reboot)" : ""}`,
      });
      res.json({ success: true, ...out });
    })
  );

  app.delete(
    "/api/sparks/:id/gpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many GPU clock changes, try again in a minute");
      await manager.reset(spark);
      recordEvent({ type: "gpu.clock.reset", severity: "info", sparkId: spark.id, message: "GPU clock cap removed" });
      res.json({ success: true });
    })
  );
}
