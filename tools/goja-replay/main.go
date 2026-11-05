// Command goja-replay runs dist/duel-sim.server.js on goja (the JavaScript engine in Nakama's
// TypeScript runtime) and replays golden logs, checking each result against the expected one.
//
//	go run ./tools/goja-replay -bundle dist/duel-sim.server.js -goldens tests/golden
//
// Each golden file is {"name", "log", "expect": {ok, winnerSeat, wins, rounds, ticks, endHash}}.
// Logs carry simVersion "any": the runner substitutes the bundle's DUEL_SIM_VERSION.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/dop251/goja"
)

type golden struct {
	Name   string                 `json:"name"`
	Log    map[string]interface{} `json:"log"`
	Expect map[string]interface{} `json:"expect"`
}

func main() {
	bundle := flag.String("bundle", "dist/duel-sim.server.js", "server bundle")
	dir := flag.String("goldens", "tests/golden", "golden log directory")
	runs := flag.Int("runs", 3, "timed runs per golden (best is reported)")
	flag.Parse()

	src, err := os.ReadFile(*bundle)
	must(err)
	vm := goja.New()
	start := time.Now()
	_, err = vm.RunScript(filepath.Base(*bundle), string(src))
	must(err)
	fmt.Printf("loaded %s in %v\n", *bundle, time.Since(start).Round(time.Millisecond))
	version := vm.Get("DUEL_SIM_VERSION").String()
	replay, ok := goja.AssertFunction(vm.Get("DuelSim").ToObject(vm).Get("replay"))
	if !ok {
		fail("DuelSim.replay is not a function")
	}

	// Garbage never throws.
	for _, junk := range []string{"null", "{}", `{"schema":1}`, `"not json"`, `{"schema":1,"simVersion":"x","seed":1,"rules":"online","staffs":[null,null],"ticks":5,"inputs":["@@",""]}`} {
		v, err := vm.RunString("(" + junk + ")")
		must(err)
		res, err := replay(goja.Undefined(), v)
		if err != nil {
			fail(fmt.Sprintf("replay threw on %s: %v", junk, err))
		}
		r := res.ToObject(vm)
		if r.Get("ok").ToBoolean() || r.Get("endHash").String() == "" {
			fail("garbage accepted: " + junk)
		}
	}

	files, err := filepath.Glob(filepath.Join(*dir, "*.json"))
	must(err)
	sort.Strings(files)
	failed := 0
	var worst time.Duration
	for _, f := range files {
		raw, err := os.ReadFile(f)
		must(err)
		var g golden
		must(json.Unmarshal(raw, &g))
		g.Log["simVersion"] = version
		logJSON, _ := json.Marshal(g.Log)
		var best time.Duration
		var out map[string]interface{}
		for i := 0; i < *runs; i++ {
			arg, err := vm.RunString("(" + string(logJSON) + ")")
			must(err)
			t0 := time.Now()
			res, err := replay(goja.Undefined(), arg)
			d := time.Since(t0)
			if err != nil {
				fail(fmt.Sprintf("%s: replay threw: %v", g.Name, err))
			}
			s, _ := json.Marshal(res.Export())
			out = map[string]interface{}{}
			must(json.Unmarshal(s, &out))
			if i == 0 || d < best {
				best = d
			}
		}
		if best > worst {
			worst = best
		}
		bad := []string{}
		for k, want := range g.Expect {
			w, _ := json.Marshal(want)
			h, _ := json.Marshal(out[k])
			if string(w) != string(h) {
				bad = append(bad, fmt.Sprintf("%s: want %s got %s", k, w, h))
			}
		}
		status := "ok  "
		if len(bad) > 0 {
			status = "FAIL"
			failed++
		}
		fmt.Printf("%s %-40s %6d ticks  %7.1f ms  %v\n", status, g.Name, int(toF(out["ticks"])), float64(best.Microseconds())/1000, bad)
	}
	fmt.Printf("%d goldens, %d failed, slowest replay %.1f ms (goja, version %s)\n", len(files), failed, float64(worst.Microseconds())/1000, version)
	if failed > 0 || len(files) == 0 {
		os.Exit(1)
	}
}

func toF(v interface{}) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

func must(err error) {
	if err != nil {
		fail(err.Error())
	}
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "goja-replay:", msg)
	os.Exit(1)
}
