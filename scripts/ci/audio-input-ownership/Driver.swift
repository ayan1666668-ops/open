import CoreFoundation
import Darwin
import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ reason: String) {
    if !condition() {
        FileHandle.standardError.write(Data("rank124-ineligible:\(reason)\n".utf8))
        exit(70)
    }
}

private func emit(_ row: [String: Any]) {
    do {
        var data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    } catch {
        require(false, "result-encoding")
    }
}

@inline(never)
private func controlScope(retained: Bool) {
    autoreleasepool {
        guard let pointer = Rank124CreateControl() else {
            require(false, "control-null")
            return
        }
        let unmanaged = Unmanaged<CFString>.fromOpaque(pointer)
        let string = retained
            ? unmanaged.takeRetainedValue() as String
            : unmanaged.takeUnretainedValue() as String
        require(string == String(cString: Rank124Expected()), "control-content")
        withExtendedLifetime(string) {}
    }
}

@inline(never)
private func getterScope(selector: Int32, mode: Int32) {
    autoreleasepool {
        let expected = String(cString: Rank124Expected())
        if selector == Int32(Rank124UID) {
            let value = AudioInputDeviceObserver.defaultInputDeviceUID()
            require(value == (mode == Int32(Rank124Owned) ? expected : nil), "UID-result")
            withExtendedLifetime(value) {}
        } else {
            let value = AudioInputDeviceObserver.defaultInputDeviceSummary()
            let name = mode == Int32(Rank124Owned) ? expected : "unknown"
            require(value == "defaultInput=\(name) (unknown)", "name-summary-result")
            withExtendedLifetime(value) {}
        }
    }
}

private func balanced(_ metrics: Rank124Metrics) -> Bool {
    metrics.liveBlocks == 0 && metrics.liveBytes == 0 && metrics.sourceObjectLive == 0
}

private func record(
    selector: Int32, kind: String, mode: String,
    metrics: Rank124Metrics, ownershipPass: Bool)
{
    emit([
        "selector": selector == Int32(Rank124UID) ? "deviceUID" : "deviceName",
        "kind": kind,
        "mode": mode,
        "allocations": metrics.allocations,
        "reallocations": metrics.reallocations,
        "deallocations": metrics.deallocations,
        "liveBlocks": metrics.liveBlocks,
        "liveBytes": metrics.liveBytes,
        "sourceObjectLive": metrics.sourceObjectLive,
        "defaultCalls": metrics.defaultCalls,
        "uidCalls": metrics.uidCalls,
        "nameCalls": metrics.nameCalls,
        "ownershipPass": ownershipPass,
    ])
}

@main
private struct Rank124OwnershipProof {
    static func main() {
        // C validates same-executable symbol identities before the first getter.
        Rank124Initialize()
        var ownershipFailures = 0
        for selector in [Int32(Rank124UID), Int32(Rank124Name)] {
            for retained in [true, false] {
                Rank124Begin(selector, Int32(Rank124Owned))
                controlScope(retained: retained)
                let observed = Rank124Snapshot()
                require(observed.allocations > 0, "control-no-allocation")
                require(
                    observed.defaultCalls == 0 && observed.uidCalls == 0 &&
                        observed.nameCalls == 0,
                    "control-called-production")
                if retained {
                    require(balanced(observed), "retained-control-not-balanced")
                } else {
                    require(
                        observed.liveBlocks > 0 && observed.liveBytes > 0 &&
                            observed.sourceObjectLive == 1,
                        "unretained-control-no-leak")
                }
                record(
                    selector: selector,
                    kind: "self-control",
                    mode: retained ? "retained" : "unretained",
                    metrics: observed,
                    ownershipPass: retained)
                Rank124CleanupAfterOracle()
                require(balanced(Rank124Snapshot()), "control-cleanup")
            }
            for mode in [Int32(Rank124Owned), Int32(Rank124Error), Int32(Rank124Nil)] {
                Rank124Begin(selector, mode)
                getterScope(selector: selector, mode: mode)
                // No CFString/String value escapes getterScope or its autoreleasepool.
                let observed = Rank124Snapshot()
                require(
                    observed.defaultCalls == 1 && observed.uidCalls == 1 &&
                        observed.nameCalls == (selector == Int32(Rank124Name) ? 1 : 0),
                    "production-selector-route")
                if mode == Int32(Rank124Owned) {
                    require(observed.allocations > 0, "getter-no-allocation")
                    if !balanced(observed) {
                        require(
                            observed.liveBlocks > 0 && observed.liveBytes > 0 &&
                                observed.sourceObjectLive == 1,
                            "unexpected-residual-lifetime")
                        ownershipFailures += 1
                    }
                } else {
                    require(
                        observed.allocations == 0 && observed.reallocations == 0 &&
                            observed.deallocations == 0 && balanced(observed),
                        "error-or-nil-allocated")
                }
                record(
                    selector: selector,
                    kind: "production-getter",
                    mode: mode == Int32(Rank124Owned) ? "owned" :
                        (mode == Int32(Rank124Error) ? "error" : "nil"),
                    metrics: observed,
                    ownershipPass: balanced(observed))
                Rank124CleanupAfterOracle()
                require(balanced(Rank124Snapshot()), "getter-cleanup")
            }
        }
        Rank124Finish()
        emit([
            "kind": "summary",
            "cases": 10,
            "ownershipFailures": ownershipFailures,
            "allFixtureAllocationsJoined": true,
        ])
        // Identical oracle in both executables; no baseline-specific success flag.
        exit(ownershipFailures == 0 ? 0 : 1)
    }
}
