#ifndef RANK124_BOUNDARY_STUB_H
#define RANK124_BOUNDARY_STUB_H

#include <stdint.h>

enum {
    Rank124UID = 0,
    Rank124Name = 1,
    Rank124Owned = 0,
    Rank124Error = 1,
    Rank124Nil = 2
};

typedef struct {
    uint64_t allocations;
    uint64_t reallocations;
    uint64_t deallocations;
    uint64_t liveBlocks;
    uint64_t liveBytes;
    uint64_t defaultCalls;
    uint64_t uidCalls;
    uint64_t nameCalls;
    uint64_t sourceObjectLive;
} Rank124Metrics;

/* No CF type crosses this interface: Swift must choose the ownership operation. */
void Rank124Initialize(void);
void Rank124Begin(int selector, int mode);
void *Rank124CreateControl(void);
const char *Rank124Expected(void);
Rank124Metrics Rank124Snapshot(void);
void Rank124CleanupAfterOracle(void);
void Rank124Finish(void);

#endif
