"""Download the three checksum-pinned RapidOCR 3.10.0 ONNX model files."""
import argparse
import hashlib
from pathlib import Path
import urllib.request

BASE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/'
MODELS = {
    'PP-OCRv6/det/PP-OCRv6_det_small.onnx': '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
    'PP-OCRv6/rec/PP-OCRv6_rec_small.onnx': '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
    'PP-OCRv4/cls/ch_ppocr_mobile_v2.0_cls_mobile.onnx': 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', type=Path, required=True)
    args = parser.parse_args()
    args.model_dir.mkdir(parents=True, exist_ok=True)
    for relative, expected in MODELS.items():
        path = args.model_dir / Path(relative).name
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == expected:
            continue
        temporary = path.with_suffix('.download')
        digest = hashlib.sha256()
        try:
            with urllib.request.urlopen(BASE + relative, timeout=120) as response, temporary.open('wb') as output:
                while chunk := response.read(1 << 20):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError('ocr_model_checksum_mismatch:' + path.name)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        print(path.name + ': verified')


if __name__ == '__main__':
    main()
