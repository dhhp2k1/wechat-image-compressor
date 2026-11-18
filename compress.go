package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"math"
	"sort"

	"golang.org/x/image/draw"
)

const maxImageBytes = 50 << 20
const maxImagePixels = 48_000_000

type compressed struct {
	data   []byte
	format string
}

func compress(ctx context.Context, data []byte, limit int) (compressed, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 {
		return compressed{}, errors.New("无法读取图片，请选择 JPG、PNG 或 WebP")
	}
	if cfg.Width > 32768 || cfg.Height > 32768 || int64(cfg.Width)*int64(cfg.Height) > maxImagePixels {
		return compressed{}, errors.New("图片像素过多")
	}
	var source image.Image
	if format == "webp" && len(data) >= 30 && string(data[12:16]) == "VP8X" && data[20]&2 != 0 {
		source, err = firstWebPFrame(data, cfg)
	} else {
		source, _, err = image.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return compressed{}, errors.New("无法解码图片")
	}
	if len(data) <= limit {
		return compressed{data, format}, nil
	}

	source = orient(source, orientation(data, format))
	width, height := source.Bounds().Dx(), source.Bounds().Dy()
	ref := sample(source, source.Bounds(), scaledSize(width, height, 320))
	edgeAware, regions := analyze(ref, source.Bounds())
	details := make([]graySample, len(regions))
	for i, region := range regions {
		details[i] = sample(source, region, region.Size())
	}
	baseWidth := 1280
	if edgeAware {
		baseWidth = 1440
	}
	if limit == 150_000 {
		baseWidth += 160
	}

	maxWidth := min(baseWidth, width, max(1, 6000*width/height), max(1, int(math.Sqrt(6_000_000*float64(width)/float64(height)))))
	previous := 0
	bestScore := -1.0
	var best []byte
	for _, scale := range []float64{1, .93, .84, .75, .66} {
		if err := ctx.Err(); err != nil {
			return compressed{}, err
		}
		w := max(1, int(math.Round(float64(maxWidth)*scale)))
		if w == previous {
			continue
		}
		previous = w
		dimensions := image.Pt(w, max(1, int(math.Round(float64(height)*float64(w)/float64(width)))))
		canvas := resize(source, source.Bounds(), dimensions)
		encoded, quality := fitJPEG(ctx, canvas, 50, limit)
		if encoded == nil {
			continue
		}
		decoded, err := jpeg.Decode(bytes.NewReader(encoded))
		if err != nil {
			return compressed{}, err
		}
		score := fidelity(decoded, ref, regions, details, width, height, edgeAware)
		score = .83*score + .17*float64(w)/float64(min(width, baseWidth))
		score -= float64(max(0, 72-quality)) * .0007
		if len(encoded) >= limit-5000 {
			score += .002
		}
		if score > bestScore {
			best, bestScore = encoded, score
		}
	}
	if best != nil {
		return compressed{best, "jpeg"}, nil
	}
	for w := previous; ; w = max(1, w*3/4) {
		if err := ctx.Err(); err != nil {
			return compressed{}, err
		}
		h := max(1, int(math.Round(float64(height)*float64(w)/float64(width))))
		if encoded, _ := fitJPEG(ctx, resize(source, source.Bounds(), image.Pt(w, h)), 1, limit); encoded != nil {
			return compressed{encoded, "jpeg"}, nil
		}
		if w == 1 {
			// A one-pixel-wide panorama can still exceed the limit at full height.
			for h > 1 {
				h = max(1, h/2)
				if encoded, _ := fitJPEG(ctx, resize(source, source.Bounds(), image.Pt(1, h)), 1, limit); encoded != nil {
					return compressed{encoded, "jpeg"}, nil
				}
			}
			return compressed{}, errors.New("无法压到所选上限")
		}
	}
}

func fitJPEG(ctx context.Context, im image.Image, low, limit int) ([]byte, int) {
	var best []byte
	quality := 0
	for high := 96; low <= high && ctx.Err() == nil; {
		mid := (low + high) / 2
		var buffer bytes.Buffer
		if err := jpeg.Encode(&buffer, im, &jpeg.Options{Quality: mid}); err != nil {
			return nil, 0
		}
		if buffer.Len() <= limit {
			best, quality = buffer.Bytes(), mid
			low = mid + 1
		} else {
			high = mid - 1
		}
	}
	return best, quality
}

func scaledSize(w, h, longSide int) image.Point {
	ratio := math.Min(1, float64(longSide)/float64(max(w, h)))
	return image.Pt(max(1, int(math.Round(float64(w)*ratio))), max(1, int(math.Round(float64(h)*ratio))))
}

func resize(im image.Image, rect image.Rectangle, size image.Point) *image.RGBA {
	out := image.NewRGBA(image.Rectangle{Max: size})
	draw.Draw(out, out.Bounds(), image.White, image.Point{}, draw.Src)
	// Bound work when sampling unusually large source images.
	if rect.Dx() > size.X*8 || rect.Dy() > size.Y*8 {
		draw.ApproxBiLinear.Scale(out, out.Bounds(), im, rect, draw.Over, nil)
	} else {
		draw.CatmullRom.Scale(out, out.Bounds(), im, rect, draw.Over, nil)
	}
	return out
}

type graySample struct {
	levels []float64
	size   image.Point
}

func sample(im image.Image, rect image.Rectangle, size image.Point) graySample {
	pixels := resize(im, rect, size).Pix
	levels := make([]float64, size.X*size.Y)
	for i := range levels {
		p := pixels[i*4:]
		levels[i] = .2126*float64(p[0]) + .7152*float64(p[1]) + .0722*float64(p[2])
	}
	return graySample{levels, size}
}

func gradient(p []float64, index, stride int) float64 {
	return math.Abs(p[index+1]-p[index-1]) + math.Abs(p[index+stride]-p[index-stride])
}

func analyze(ref graySample, bounds image.Rectangle) (bool, []image.Rectangle) {
	type tile struct{ x, y, edges int }
	var tiles [16]tile
	for i := range tiles {
		tiles[i] = tile{x: i % 4, y: i / 4}
	}
	w, h := ref.size.X, ref.size.Y
	var edges, flat, count int
	for y := 1; y < h-1; y++ {
		for x := 1; x < w-1; x++ {
			g := gradient(ref.levels, y*w+x, w)
			if g > 42 {
				tiles[(y*4/h)*4+x*4/w].edges++
				edges++
			}
			if g < 12 {
				flat++
			}
			count++
		}
	}
	sort.SliceStable(tiles[:], func(i, j int) bool { return tiles[i].edges > tiles[j].edges })
	side := min(192, bounds.Dx(), bounds.Dy())
	var regions []image.Rectangle
	for _, t := range tiles {
		if t.edges == 0 || len(regions) == 3 {
			break
		}
		x := min(bounds.Dx()-side, max(0, (2*t.x+1)*bounds.Dx()/8-side/2)) + bounds.Min.X
		y := min(bounds.Dy()-side, max(0, (2*t.y+1)*bounds.Dy()/8-side/2)) + bounds.Min.Y
		r := image.Rect(x, y, x+side, y+side)
		overlap := false
		for _, existing := range regions {
			overlap = overlap || r.Overlaps(existing)
		}
		if !overlap {
			regions = append(regions, r)
		}
	}
	return flat*2 > count && edges*20 > count, regions
}

func fidelity(im image.Image, ref graySample, regions []image.Rectangle, details []graySample, width, height int, edgeAware bool) float64 {
	edgeWeight, localWeight := .20, .35
	if edgeAware {
		edgeWeight, localWeight = .42, .65
	}
	score := similarity(ref, sample(im, im.Bounds(), ref.size), edgeWeight)
	if len(regions) == 0 {
		return score
	}
	local := 0.0
	w, h := im.Bounds().Dx(), im.Bounds().Dy()
	for i, r := range regions {
		x, y := r.Min.X*w/width, r.Min.Y*h/height
		region := image.Rect(x, y, max(x+1, r.Max.X*w/width), max(y+1, r.Max.Y*h/height))
		local += similarity(details[i], sample(im, region, details[i].size), edgeWeight)
	}
	return score*(1-localWeight) + local/float64(len(regions))*localWeight
}

func similarity(a, b graySample, edgeWeight float64) float64 {
	w, h := a.size.X, a.size.Y
	const c1 = 6.5025
	const c2 = 58.5225
	var total, blocks float64
	for y := 0; y < h; y += 8 {
		for x := 0; x < w; x += 8 {
			var sa, sb, saa, sbb, sab, n float64
			for yy := y; yy < min(y+8, h); yy++ {
				for xx := x; xx < min(x+8, w); xx++ {
					i := yy*w + xx
					va, vb := a.levels[i], b.levels[i]
					sa, sb = sa+va, sb+vb
					saa, sbb, sab = saa+va*va, sbb+vb*vb, sab+va*vb
					n++
				}
			}
			ma, mb := sa/n, sb/n
			total += ((2*ma*mb + c1) * (2*(sab/n-ma*mb) + c2)) /
				((ma*ma + mb*mb + c1) * (max(0, saa/n-ma*ma) + max(0, sbb/n-mb*mb) + c2))
			blocks++
		}
	}
	var edges, matching float64
	for y := 1; y < h-1; y++ {
		for x := 1; x < w-1; x++ {
			i := y*w + x
			ga := gradient(a.levels, i, w)
			if ga >= 24 {
				edges += ga
				matching += min(ga, gradient(b.levels, i, w))
			}
		}
	}
	retention := 1.0
	if edges > 0 {
		retention = matching / edges
	}
	return max(0, total/blocks)*(1-edgeWeight) + retention*edgeWeight
}

func orientation(data []byte, format string) uint16 {
	switch format {
	case "jpeg":
		for rest := data[2:]; len(rest) >= 4 && rest[0] == 0xff; {
			if rest[1] == 0xff {
				rest = rest[1:]
				continue
			}
			length := int(binary.BigEndian.Uint16(rest[2:4]))
			if rest[1] == 0xda || length < 2 || length+2 > len(rest) {
				break
			}
			segment := rest[4 : length+2]
			if rest[1] == 0xe1 && bytes.HasPrefix(segment, []byte("Exif\x00\x00")) {
				return tiffOrientation(segment[6:])
			}
			rest = rest[length+2:]
		}
	case "webp":
		for rest := data[12:]; len(rest) >= 8; {
			length := uint64(binary.LittleEndian.Uint32(rest[4:8]))
			if length > uint64(len(rest)-8) {
				break
			}
			if string(rest[:4]) == "EXIF" {
				exif := rest[8 : 8+length]
				return tiffOrientation(bytes.TrimPrefix(exif, []byte("Exif\x00\x00")))
			}
			length += length % 2
			if length > uint64(len(rest)-8) {
				break
			}
			rest = rest[8+length:]
		}
	case "png":
		for rest := data[8:]; len(rest) >= 12; {
			length := uint64(binary.BigEndian.Uint32(rest[:4]))
			if length > uint64(len(rest)-12) {
				break
			}
			if string(rest[4:8]) == "eXIf" {
				return tiffOrientation(rest[8 : 8+length])
			}
			rest = rest[12+length:]
		}
	}
	return 1
}

func tiffOrientation(data []byte) uint16 {
	if len(data) < 8 {
		return 1
	}
	var order binary.ByteOrder
	switch string(data[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 1
	}
	offset := uint64(order.Uint32(data[4:8]))
	if order.Uint16(data[2:4]) != 42 || offset > uint64(len(data)-2) {
		return 1
	}
	entries := int(order.Uint16(data[offset:]))
	data = data[offset+2:]
	for i := 0; i < entries && len(data) >= 12; i, data = i+1, data[12:] {
		if order.Uint16(data) == 0x0112 && order.Uint16(data[2:]) == 3 && order.Uint32(data[4:]) == 1 {
			return order.Uint16(data[8:])
		}
	}
	return 1
}

type orientedImage struct {
	image.Image
	value uint16
}

func orient(im image.Image, value uint16) image.Image {
	if value < 2 || value > 8 {
		return im
	}
	return orientedImage{im, value}
}

func (im orientedImage) Bounds() image.Rectangle {
	size := im.Image.Bounds().Size()
	if im.value >= 5 {
		size.X, size.Y = size.Y, size.X
	}
	return image.Rectangle{Max: size}
}

func (im orientedImage) At(x, y int) color.Color {
	b := im.Image.Bounds()
	w, h := b.Dx()-1, b.Dy()-1
	switch im.value {
	case 2:
		x = w - x
	case 3:
		x, y = w-x, h-y
	case 4:
		y = h - y
	case 5:
		x, y = y, x
	case 6:
		x, y = y, h-x
	case 7:
		x, y = w-y, h-x
	case 8:
		x, y = w-y, x
	}
	return im.Image.At(x+b.Min.X, y+b.Min.Y)
}
