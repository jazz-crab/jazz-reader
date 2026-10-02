#!/bin/sh
# Регенерация иконки из icon.svg: PNG-набор + многослойный ICO.
# Нужны rsvg-convert и python3 (Pillow). Результат кладётся рядом с этим скриптом.
#   ./build/icon/make-icons.sh
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
SIZES="16 20 24 32 40 48 64 128 256"
# Слои до 24px получают увеличенный кегль: на кегле из icon.svg капитель
# «MD» на 16px вырождается в 4 пикселя высоты и не читается. Так же делают
# штатные иконки Windows — там на каждый малый размер свой слой.
SMALL_SIZES="16 20 24"
SMALL_SCALE=1.2

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

python3 - "$DIR/icon.svg" "$TMP/icon-small.svg" "$SMALL_SCALE" <<'PY'
import re, sys
src, dst, k = sys.argv[1], sys.argv[2], sys.argv[3]
svg = open(src, encoding='utf-8').read()
# Масштабируем только текст относительно центра плитки.
t = 'transform="translate(128 128) scale(%s) translate(-128 -128)"' % k
svg, n = re.subn(r'(<text\b)', r'\1 ' + t, svg, count=1)
if n != 1:
    raise SystemExit('no <text> in icon.svg')
open(dst, 'w', encoding='utf-8').write(svg)
PY

for s in $SIZES 512; do
	case " $SMALL_SIZES " in
	*" $s "*) src="$TMP/icon-small.svg" ;;
	*) src="$DIR/icon.svg" ;;
	esac
	# Каждый размер растрируется нативно (rsvg отдаёт текст через cairo уже под
	# нужный кегль), а не даунскейлом с 512 — иначе на 16px буквы рассыпаются.
	rsvg-convert -w "$s" -h "$s" -f png "$src" -o "$TMP/$s.png"
	cp "$TMP/$s.png" "$DIR/icon-$s.png"
done

cp "$DIR/icon-512.png" "$DIR/icon.png"

python3 - "$DIR" "$TMP" "$SIZES" <<'PY'
import os, struct, sys
d, tmp, sizes = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split()]

# ICO с PNG-внутри (Vista+). Заголовок ICONDIR + по 16 байт на слой + payload.
blobs, entries = [], []
for s in sizes:
    data = open(os.path.join(tmp, '%d.png' % s), 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit('not a png: %d' % s)
    # В каталоге ICO значение 0 означает «256».
    entries.append(struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), 0))
    blobs.append(data)

offset = 6 + 16 * len(entries)
out = [struct.pack('<HHH', 0, 1, len(entries))]
for e, b in zip(entries, blobs):
    out.append(e[:12] + struct.pack('<I', offset))
    offset += len(b)
for b in blobs:
    out.append(b)

ico = os.path.join(d, 'icon.ico')
open(ico, 'wb').write(b''.join(out))
print('icon.ico: %d layers %s, %d bytes' % (len(entries), sizes, os.path.getsize(ico)))
PY

ls -1 "$DIR"