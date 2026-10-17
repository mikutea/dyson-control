using System;

namespace DysonControl.Bridge
{
    internal sealed class BridgeSaveObservation
    {
        internal long SaveTime = -1;
        internal BridgeFileEvidence Dsv = new BridgeFileEvidence();
        internal BridgeFileEvidence Server = new BridgeFileEvidence();
        internal BridgeFileEvidence Moddsv = new BridgeFileEvidence();
    }

    internal sealed class SaveStabilityTracker
    {
        private readonly BridgeSaveObservation before;
        private readonly bool requireModdsv;
        private BridgeSaveObservation candidate;
        private long candidateSince;
        private int candidateSamples;

        internal SaveStabilityTracker(BridgeSaveObservation before)
        {
            this.before = Copy(before ?? throw new ArgumentNullException(nameof(before)));
            requireModdsv = before.Moddsv != null && before.Moddsv.Bytes >= 0;
        }

        internal bool Observe(BridgeSaveObservation current, long monotonic, long stabilityTicks, out BridgeSaveObservation stable)
        {
            stable = null;
            if (!TryValidate(current, out _))
            {
                candidate = null;
                candidateSamples = 0;
                return false;
            }

            if (candidate == null || !Same(candidate, current))
            {
                candidate = Copy(current);
                candidateSince = monotonic;
                candidateSamples = 1;
                return false;
            }

            candidateSamples++;
            if (candidateSamples < 3 || monotonic < candidateSince || monotonic - candidateSince < stabilityTicks) return false;
            stable = Copy(candidate);
            return true;
        }

        internal string ExplainFailure(BridgeSaveObservation current)
        {
            return TryValidate(current, out var errorCode) ? "SAVE_OUTPUT_UNSTABLE" : errorCode;
        }

        private bool TryValidate(BridgeSaveObservation current, out string errorCode)
        {
            if (current == null || !Present(current.Dsv) || !Present(current.Server))
            {
                errorCode = "SAVE_PAIR_MISSING";
                return false;
            }
            var dsvChanged = Changed(before.Dsv, current.Dsv);
            var serverChanged = Changed(before.Server, current.Server);
            if (!dsvChanged && !serverChanged)
            {
                errorCode = "SAVE_PAIR_UNCHANGED";
                return false;
            }
            if (!dsvChanged || !serverChanged)
            {
                errorCode = "SAVE_PAIR_PARTIAL";
                return false;
            }
            if (current.SaveTime <= before.SaveTime)
            {
                errorCode = "SAVE_TIME_UNCHANGED";
                return false;
            }
            if (requireModdsv && !Present(current.Moddsv))
            {
                errorCode = "MODDSV_MISSING";
                return false;
            }
            if (requireModdsv && !Changed(before.Moddsv, current.Moddsv))
            {
                errorCode = "MODDSV_UNCHANGED";
                return false;
            }
            if (!requireModdsv && current.Moddsv.Bytes >= 0 && !Present(current.Moddsv))
            {
                errorCode = "MODDSV_INVALID";
                return false;
            }
            errorCode = "NONE";
            return true;
        }

        private static bool Present(BridgeFileEvidence value) => value != null && value.Bytes > 0 && value.Ticks > 0;
        private static bool Changed(BridgeFileEvidence left, BridgeFileEvidence right) =>
            left.Bytes != right.Bytes || left.Ticks != right.Ticks;

        private static bool Same(BridgeSaveObservation left, BridgeSaveObservation right) =>
            left.SaveTime == right.SaveTime && Same(left.Dsv, right.Dsv) && Same(left.Server, right.Server) && Same(left.Moddsv, right.Moddsv);

        private static bool Same(BridgeFileEvidence left, BridgeFileEvidence right) =>
            left.Bytes == right.Bytes && left.Ticks == right.Ticks;

        private static BridgeSaveObservation Copy(BridgeSaveObservation value)
        {
            return new BridgeSaveObservation
            {
                SaveTime = value.SaveTime,
                Dsv = Copy(value.Dsv),
                Server = Copy(value.Server),
                Moddsv = Copy(value.Moddsv)
            };
        }

        private static BridgeFileEvidence Copy(BridgeFileEvidence value)
        {
            return new BridgeFileEvidence { Bytes = value.Bytes, Ticks = value.Ticks, Changed = value.Changed };
        }
    }
}
