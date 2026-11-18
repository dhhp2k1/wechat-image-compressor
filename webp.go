package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"

	"golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

func firstWebPFrame(data []byte, cfg image.Config) (image.Image, error) {
	const headerSize = 16
	for rest := data[12:]; len(rest) >= 8; {
		length := int(binary.LittleEndian.Uint32(rest[4:8]))
		padded := length + length%2
		if padded > len(rest)-8 {
			break
		}
		if string(rest[:4]) != "ANMF" {
			rest = rest[8+padded:]
			continue
		}
		if length < headerSize+8 {
			break
		}
		part := rest[8 : 8+length]
		x, y := 2*read24(part), 2*read24(part[3:])
		w, h := 1+read24(part[6:]), 1+read24(part[9:])
		if x+w > cfg.Width || y+h > cfg.Height {
			break
		}
		chunks := part[headerSize:]
		// The frame uses standard WebP chunks with its own dimensions and alpha flag.
		standalone := make([]byte, 30+len(chunks))
		copy(standalone, "RIFF")
		binary.LittleEndian.PutUint32(standalone[4:], uint32(len(standalone)-8))
		copy(standalone[8:], "WEBPVP8X")
		binary.LittleEndian.PutUint32(standalone[16:], 10)
		if bytes.HasPrefix(chunks, []byte("ALPH")) {
			standalone[20] = 0x10
		}
		copy(standalone[24:30], part[6:12])
		copy(standalone[30:], chunks)
		frame, err := webp.Decode(bytes.NewReader(standalone))
		if err != nil {
			return nil, err
		}
		canvas := image.NewRGBA(image.Rect(0, 0, cfg.Width, cfg.Height))
		draw.Draw(canvas, image.Rect(x, y, x+w, y+h), frame, frame.Bounds().Min, draw.Src)
		return canvas, nil
	}
	return nil, errors.New("invalid animated WebP frame")
}

func read24(b []byte) int {
	return int(b[0]) | int(b[1])<<8 | int(b[2])<<16
}
