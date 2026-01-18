package main

import (
	"fmt"
	"net/http"
)

func main() {
	fmt.Println("Victoriae Authoritative Server starting on :8080...")
	// Minimal server to keep the process alive for Task
	http.ListenAndServe(":8080", nil)
}
