package api

import (
    "net/http"
    "example/internal/store"
)

func Handler(s *store.Store) http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("/increment", func(w http.ResponseWriter, r *http.Request) {
        s.Increment(r.URL.Query().Get("key"))
        w.WriteHeader(http.StatusNoContent)
    })
    mux.HandleFunc("/value", func(w http.ResponseWriter, r *http.Request) {
        _ = s.Value(r.URL.Query().Get("key"))
        w.WriteHeader(http.StatusNoContent)
    })
    return mux
}
