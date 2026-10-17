using System;
using System.Diagnostics;

namespace DysonControl.Bridge
{
    internal sealed class MetricsPublisher
    {
        private readonly BridgeFileStore store;
        private readonly string sessionId;
        private readonly int processId;
        private readonly Func<bool> runtimeReady;
        private long nextPublishMonotonic;
        private Baseline baseline;

        internal MetricsPublisher(BridgeFileStore store, string sessionId, int processId, Func<bool> runtimeReady)
        {
            this.store = store ?? throw new ArgumentNullException(nameof(store));
            this.sessionId = sessionId;
            this.processId = processId;
            this.runtimeReady = runtimeReady ?? throw new ArgumentNullException(nameof(runtimeReady));
        }

        internal void Tick(long nowUnixMs, long nowMonotonic)
        {
            if (nowMonotonic < nextPublishMonotonic) return;
            nextPublishMonotonic = nowMonotonic + Stopwatch.Frequency * 2;
            var ready = runtimeReady() && !GameMain.isPaused;
            var gameTick = ready ? GameMain.gameTick : -1;
            var ups = ready ? FPSController.currentUPS : -1;
            if (!ready || gameTick < 0 || double.IsNaN(ups) || double.IsInfinity(ups) || ups < 0)
            {
                baseline = null;
                Publish(nowUnixMs, "unavailable", -1, -1, -1);
                return;
            }
            if (baseline == null || nowMonotonic <= baseline.Monotonic || gameTick < baseline.GameTick)
            {
                baseline = new Baseline(gameTick, nowMonotonic);
                Publish(nowUnixMs, "unavailable", -1, -1, -1);
                return;
            }
            var elapsed = (nowMonotonic - baseline.Monotonic) / (double)Stopwatch.Frequency;
            if (elapsed < 1.5 || elapsed > 10)
            {
                baseline = new Baseline(gameTick, nowMonotonic);
                Publish(nowUnixMs, "unavailable", -1, -1, -1);
                return;
            }
            var tps = (gameTick - baseline.GameTick) / elapsed;
            baseline = new Baseline(gameTick, nowMonotonic);
            if (double.IsNaN(tps) || double.IsInfinity(tps) || tps < 0 || ups > 10000 || tps > 10000)
            {
                Publish(nowUnixMs, "unavailable", -1, -1, -1);
                return;
            }
            Publish(nowUnixMs, "active", ups, tps, gameTick);
        }

        private void Publish(long nowUnixMs, string state, double ups, double tps, long gameTick)
        {
            store.WriteMetrics(BridgeProtocol.SerializeMetrics(new BridgeMetrics
            {
                SessionId = sessionId, ProcessId = processId, WrittenAtUnixMs = nowUnixMs,
                State = state, Ups = ups, Tps = tps, GameTick = gameTick
            }, store.Secret));
        }

        private sealed class Baseline
        {
            internal Baseline(long gameTick, long monotonic) { GameTick = gameTick; Monotonic = monotonic; }
            internal long GameTick { get; }
            internal long Monotonic { get; }
        }
    }
}
