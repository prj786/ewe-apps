# A synthetic "phone photo": 960x720 gradient with a TOP marker and EXIF (Make/Model/date,
# orientation). Usage: python3 -I make_photo.py <out.jpg> <orientation>
# The picture fixtures came from it:
#   python3 -I make_photo.py src6.jpg 6 && heif-enc -q 60 src6.jpg -o pictures/rotated.heic
#     (heif-enc turns EXIF orientation 6 into a HEIF rotation: shown 720×960)
#   python3 -I make_photo.py src1.jpg 1 && magick src1.jpg src1.png
#   avifenc -q 60 src1.png pictures/photo.avif && cjxl src1.png pictures/photo.jxl -d 2
import sys
from PIL import Image, ImageDraw, ImageFont, TiffImagePlugin
w, h = 960, 720
img = Image.new("RGB", (w, h))
px = img.load()
for y in range(h):
    for x in range(w):
        px[x, y] = (40 + x * 180 // w, 90 + y * 120 // h, 160)
d = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype("/usr/share/fonts/noto/NotoSans-Bold.ttf", 90)
except Exception:
    font = ImageFont.load_default()
d.rectangle([0, 0, w, 120], fill=(250, 200, 40))
d.text((40, 10), "TOP  ewe", fill=(20, 20, 20), font=font)
d.ellipse([w//2-120, h//2-80, w//2+120, h//2+160], fill=(240, 240, 240))
exif = Image.Exif()
exif[0x010F] = "ewe"           # Make
exif[0x0110] = "Fixture Phone"  # Model
exif[0x0112] = int(sys.argv[2]) # Orientation
exif[0x0131] = "ewe fixtures"   # Software
ifd = exif.get_ifd(0x8769)
ifd[0x9003] = "2026:11:21 12:00:00"  # DateTimeOriginal
ifd[0x829A] = TiffImagePlugin.IFDRational(1, 250)  # ExposureTime
ifd[0x829D] = TiffImagePlugin.IFDRational(18, 10)  # FNumber
ifd[0x8827] = 100                    # ISO
img.save(sys.argv[1], "JPEG", quality=90, exif=exif)
