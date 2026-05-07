package main

import (
	"io/ioutil"
	"os"
	"strconv"
	"sync"
)

type CursorManager struct {
	mu   sync.Mutex
	path string
}

func (c *CursorManager) Get() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := ioutil.ReadFile(c.path)
	if err != nil { return 0 }
	val, _ := strconv.ParseInt(string(data), 10, 64)
	return val
}

func (c *CursorManager) Set(index int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	tmpPath := c.path + ".tmp"
	err := ioutil.WriteFile(tmpPath, []byte(strconv.FormatInt(index, 10)), 0644)
	if err != nil { return err }
	return os.Rename(tmpPath, c.path)
}
