package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math/rand/v2"
	"testing"
)

func TestCompressKeepsOriginalOrMeetsByteCap(t *testing.T) {
	var original bytes.Buffer
	plain := image.NewRGBA(image.Rect(0, 0, 16, 16))
	if err := png.Encode(&original, plain); err != nil {
		t.Fatal(err)
	}
	kept, err := compress(t.Context(), original.Bytes(), 75_000)
	if err != nil || kept.format != "png" || !bytes.Equal(kept.data, original.Bytes()) {
		t.Fatalf("small PNG should be unchanged: %v", err)
	}

	source := image.NewNRGBA(image.Rect(0, 0, 960, 750))
	random := rand.New(rand.NewPCG(1, 2))
	for y := 0; y < source.Bounds().Dy(); y++ {
		for x := 0; x < source.Bounds().Dx(); x++ {
			if x >= 100 && y >= 100 {
				source.SetNRGBA(x, y, color.NRGBA{uint8(random.Uint32()), uint8(random.Uint32()), uint8(random.Uint32()), 255})
			}
		}
	}
	original.Reset()
	if err := png.Encode(&original, source); err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int{65_000, 75_000, 85_000, 150_000} {
		result, err := compress(t.Context(), original.Bytes(), limit)
		if err != nil || result.format != "jpeg" || len(result.data) == 0 || len(result.data) > limit {
			t.Fatalf("limit %d, got %d %s bytes: %v", limit, len(result.data), result.format, err)
		}
		encoded, _, err := image.Decode(bytes.NewReader(result.data))
		if err != nil {
			t.Fatal(err)
		}
		r, g, b, _ := encoded.At(0, 0).RGBA()
		if r < 63000 || g < 63000 || b < 63000 {
			t.Fatalf("transparent area should be white, got %d %d %d", r, g, b)
		}
	}
}
