package store

import "sync"

type Store struct {
    values map[string]int
    snapshots map[string]int
    mu sync.Mutex
}

func New() *Store {
    return &Store{values: make(map[string]int), snapshots: make(map[string]int)}
}

func (s *Store) Snapshot(key string, value int) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.snapshots[key] = value
}

func (s *Store) ReadSnapshot(key string) int {
    s.mu.Lock()
    defer s.mu.Unlock()
    return s.snapshots[key]
}

func (s *Store) Increment(key string) {
    s.values[key] = s.values[key] + 1
}

func (s *Store) Value(key string) int {
    return s.values[key]
}

func (s *Store) SnapshotCount() int {
    s.mu.Lock()
    defer s.mu.Unlock()
    return len(s.snapshots)
}
