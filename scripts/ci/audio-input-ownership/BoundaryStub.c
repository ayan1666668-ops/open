#include "BoundaryStub.h"

#include <AudioToolbox/AudioToolbox.h>
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { SlotCount = 64, MaxAllocation = 1024 * 1024 };
static const AudioObjectID SyntheticDevice = 0x124;
static const char Expected[] =
    "rank124-synthetic-owned-string-0123456789-abcdefghijklmnopqrstuvwxyz-"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-abcdefghijklmnopqrstuvwxyz-"
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ-end";

typedef struct {
    void *pointer;
    size_t size;
} Slot;

typedef struct {
    CFAllocatorRef allocator;
    Slot slots[SlotCount];
    Rank124Metrics metrics;
    CFStringRef source; /* Non-retaining observation of the returned +1 object. */
    void *sourceAllocation;
} Ledger;

static Ledger ledgers[2];
static int selected = -1;
static int mode = -1;
static bool initialized;
static bool created;

static _Noreturn void fail(const char *reason) {
    fprintf(stderr, "rank124-ineligible:%s\n", reason);
    exit(70);
}

static Ledger *current(void) {
    if (!initialized || selected < 0 || selected > 1) {
        fail("case-not-selected");
    }
    return &ledgers[selected];
}

static int findSlot(Ledger *ledger, const void *pointer) {
    for (int i = 0; i < SlotCount; i++) {
        if (ledger->slots[i].pointer == pointer) {
            return i;
        }
    }
    return -1;
}

static int containingSlot(Ledger *ledger, const void *pointer) {
    uintptr_t address = (uintptr_t)pointer;
    int found = -1;
    for (int i = 0; i < SlotCount; i++) {
        uintptr_t start = (uintptr_t)ledger->slots[i].pointer;
        if (ledger->slots[i].pointer && address >= start &&
            address - start < ledger->slots[i].size) {
            if (found >= 0) {
                fail("overlapping-allocations");
            }
            found = i;
        }
    }
    return found;
}

static size_t boundedSize(CFIndex requested) {
    if (requested <= 0 || requested > MaxAllocation) {
        fail("allocator-size");
    }
    return (size_t)requested;
}

static void *allocate(CFIndex requested, CFOptionFlags hint, void *info) {
    (void)hint;
    Ledger *ledger = info;
    size_t size = boundedSize(requested);
    int slot = findSlot(ledger, NULL);
    if (slot < 0) {
        fail("allocator-capacity");
    }
    void *pointer = malloc(size);
    if (!pointer) {
        fail("allocator-out-of-memory");
    }
    ledger->slots[slot] = (Slot){pointer, size};
    ledger->metrics.allocations++;
    ledger->metrics.liveBlocks++;
    ledger->metrics.liveBytes += size;
    return pointer;
}

static void deallocate(void *pointer, void *info) {
    if (!pointer) {
        return;
    }
    Ledger *ledger = info;
    int slot = findSlot(ledger, pointer);
    if (slot < 0) {
        fail("allocator-unknown-free");
    }
    ledger->metrics.liveBytes -= ledger->slots[slot].size;
    ledger->metrics.liveBlocks--;
    ledger->metrics.deallocations++;
    ledger->slots[slot] = (Slot){0};
    if (ledger->sourceAllocation == pointer) {
        ledger->source = NULL;
        ledger->sourceAllocation = NULL;
    }
    free(pointer);
}

static void *reallocate(void *pointer, CFIndex requested, CFOptionFlags hint, void *info) {
    Ledger *ledger = info;
    if (!pointer) {
        return allocate(requested, hint, info);
    }
    if (ledger->sourceAllocation == pointer) {
        fail("source-object-reallocation");
    }
    if (requested == 0) {
        deallocate(pointer, info);
        return NULL;
    }
    size_t size = boundedSize(requested);
    int slot = findSlot(ledger, pointer);
    if (slot < 0) {
        fail("allocator-unknown-reallocation");
    }
    void *replacement = realloc(pointer, size);
    if (!replacement) {
        fail("allocator-out-of-memory");
    }
    ledger->metrics.liveBytes -= ledger->slots[slot].size;
    ledger->metrics.liveBytes += size;
    ledger->metrics.reallocations++;
    ledger->slots[slot] = (Slot){replacement, size};
    return replacement;
}

static CFIndex preferredSize(CFIndex size, CFOptionFlags hint, void *info) {
    (void)hint;
    (void)info;
    (void)boundedSize(size);
    return size;
}

static void verifySymbol(const char *name, const void *expected, const void *ownImage) {
    Dl_info information = {0};
    void *resolved = dlsym(RTLD_DEFAULT, name);
    if (!resolved || resolved != expected || !dladdr(resolved, &information) ||
        information.dli_fbase != ownImage) {
        fail("C-symbol-not-owned-by-executable");
    }
}

void Rank124Initialize(void) {
    if (initialized) {
        fail("duplicate-initialize");
    }
    Dl_info own = {0};
    if (!dladdr((const void *)&Rank124Initialize, &own)) {
        fail("missing-executable-image");
    }
    verifySymbol("AudioObjectGetPropertyData",
                 (const void *)&AudioObjectGetPropertyData, own.dli_fbase);
    verifySymbol("AudioObjectGetPropertyDataSize",
                 (const void *)&AudioObjectGetPropertyDataSize, own.dli_fbase);
    verifySymbol("AudioObjectAddPropertyListenerBlock",
                 (const void *)&AudioObjectAddPropertyListenerBlock, own.dli_fbase);
    verifySymbol("AudioObjectRemovePropertyListenerBlock",
                 (const void *)&AudioObjectRemovePropertyListenerBlock, own.dli_fbase);
    verifySymbol("AudioUnitSetProperty", (const void *)&AudioUnitSetProperty, own.dli_fbase);
    for (int i = 0; i < 2; i++) {
        CFAllocatorContext context = {
            .version = 0,
            .info = &ledgers[i],
            .allocate = allocate,
            .reallocate = reallocate,
            .deallocate = deallocate,
            .preferredSize = preferredSize,
        };
        ledgers[i].allocator = CFAllocatorCreate(kCFAllocatorDefault, &context);
        if (!ledgers[i].allocator) {
            fail("allocator-creation");
        }
    }
    initialized = true;
}

void Rank124Begin(int selector, int nextMode) {
    if (!initialized || selector < 0 || selector > 1 || nextMode < 0 || nextMode > 2) {
        fail("invalid-case");
    }
    for (int i = 0; i < 2; i++) {
        if (ledgers[i].metrics.liveBlocks || ledgers[i].metrics.liveBytes ||
            ledgers[i].source || ledgers[i].sourceAllocation) {
            fail("previous-case-not-clean");
        }
    }
    selected = selector;
    mode = nextMode;
    created = false;
    memset(&current()->metrics, 0, sizeof(Rank124Metrics));
}

static CFStringRef createOwned(void) {
    Ledger *ledger = current();
    if (mode != Rank124Owned || created) {
        fail("unexpected-string-creation");
    }
    created = true;
    CFStringRef string = CFStringCreateWithCString(
        ledger->allocator, Expected, kCFStringEncodingUTF8);
    int slot = string ? containingSlot(ledger, string) : -1;
    if (!string || CFGetAllocator(string) != ledger->allocator ||
        slot < 0 || !ledger->metrics.liveBlocks) {
        fail("string-not-witnessed-by-custom-allocator");
    }
    /* CF may prepend allocator metadata; bind the object to its owning block. */
    ledger->source = string;
    ledger->sourceAllocation = ledger->slots[slot].pointer;
    return string;
}

void *Rank124CreateControl(void) {
    return (void *)createOwned();
}

const char *Rank124Expected(void) {
    return Expected;
}

Rank124Metrics Rank124Snapshot(void) {
    Ledger *ledger = current();
    Rank124Metrics snapshot = ledger->metrics;
    int slot = ledger->sourceAllocation ? findSlot(ledger, ledger->sourceAllocation) : -1;
    if (ledger->source) {
        if (slot < 0 || containingSlot(ledger, ledger->source) != slot) {
            fail("source-allocation-identity");
        }
        snapshot.sourceObjectLive = 1;
    } else if (ledger->sourceAllocation) {
        fail("allocation-without-source");
    }
    return snapshot;
}

void Rank124CleanupAfterOracle(void) {
    Ledger *ledger = current();
    /* The +1 is consumed here only if the measured production/control path leaked it. */
    if (Rank124Snapshot().sourceObjectLive) {
        CFRelease(ledger->source);
    }
    if (ledger->source || ledger->sourceAllocation ||
        ledger->metrics.liveBlocks || ledger->metrics.liveBytes) {
        fail("post-oracle-cleanup-not-balanced");
    }
}

void Rank124Finish(void) {
    if (!initialized) {
        fail("not-initialized");
    }
    for (int i = 0; i < 2; i++) {
        if (ledgers[i].metrics.liveBlocks || ledgers[i].metrics.liveBytes ||
            ledgers[i].source || ledgers[i].sourceAllocation) {
            fail("finish-with-live-object");
        }
        CFRelease(ledgers[i].allocator);
        ledgers[i].allocator = NULL;
    }
    initialized = false;
    selected = -1;
}

OSStatus AudioObjectGetPropertyData(
    AudioObjectID object, const AudioObjectPropertyAddress *address,
    UInt32 qualifierSize, const void *qualifier, UInt32 *size, void *output) {
    Ledger *ledger = current();
    if (!address || !size || !output || qualifierSize != 0 || qualifier != NULL ||
        address->mScope != kAudioObjectPropertyScopeGlobal ||
        address->mElement != kAudioObjectPropertyElementMain) {
        fail("unexpected-property-shape");
    }
    if (object == kAudioObjectSystemObject &&
        address->mSelector == kAudioHardwarePropertyDefaultInputDevice) {
        if (*size != sizeof(AudioObjectID)) {
            fail("default-device-size");
        }
        ledger->metrics.defaultCalls++;
        AudioObjectID device = SyntheticDevice;
        memcpy(output, &device, sizeof(device));
        return noErr;
    }
    if (object != SyntheticDevice || *size != sizeof(CFStringRef)) {
        fail("unexpected-object-or-string-size");
    }
    int queried;
    if (address->mSelector == kAudioDevicePropertyDeviceUID) {
        queried = Rank124UID;
        ledger->metrics.uidCalls++;
    } else if (address->mSelector == kAudioObjectPropertyName) {
        queried = Rank124Name;
        ledger->metrics.nameCalls++;
    } else {
        fail("unexpected-property-selector");
    }
    CFStringRef value = NULL;
    if (queried == selected && mode == Rank124Owned) {
        value = createOwned();
    }
    memcpy(output, &value, sizeof(value));
    return queried == selected && mode == Rank124Error ? kAudioHardwareBadObjectError : noErr;
}

OSStatus AudioObjectGetPropertyDataSize(
    AudioObjectID object, const AudioObjectPropertyAddress *address,
    UInt32 qualifierSize, const void *qualifier, UInt32 *size) {
    (void)object; (void)address; (void)qualifierSize; (void)qualifier; (void)size;
    fail("forbidden-HAL-size-query");
}

OSStatus AudioObjectAddPropertyListenerBlock(
    AudioObjectID object, const AudioObjectPropertyAddress *address,
    dispatch_queue_t queue, AudioObjectPropertyListenerBlock block) {
    (void)object; (void)address; (void)queue; (void)block;
    fail("forbidden-HAL-listener-add");
}

OSStatus AudioObjectRemovePropertyListenerBlock(
    AudioObjectID object, const AudioObjectPropertyAddress *address,
    dispatch_queue_t queue, AudioObjectPropertyListenerBlock block) {
    (void)object; (void)address; (void)queue; (void)block;
    fail("forbidden-HAL-listener-remove");
}

OSStatus AudioUnitSetProperty(
    AudioUnit unit, AudioUnitPropertyID property, AudioUnitScope scope,
    AudioUnitElement element, const void *data, UInt32 size) {
    (void)unit; (void)property; (void)scope; (void)element; (void)data; (void)size;
    fail("forbidden-HAL-unit-write");
}
