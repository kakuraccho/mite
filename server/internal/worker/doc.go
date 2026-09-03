// Package worker hosts process-local background workers. Concrete AI and
// deletion workers are added by their feature lanes after the shared
// transaction and external-service boundaries are stable.
package worker
