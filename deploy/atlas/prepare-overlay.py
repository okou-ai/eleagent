#!/usr/bin/env python3
"""Make converted MTP metadata agree with the overlay, preserving source files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile


def replace_json(path, document):
    # The converter symlinks metadata to the source checkpoint. Replacing the
    # directory entry is essential: writing through that link edits the source.
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(document, output, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare(model_root):
    source = model_root / 'nvidia--GLM-5.3-Flash-NVFP4'
    overlay = model_root / 'atlas-overlay'
    receipt = json.loads((overlay / 'conversion.complete.json').read_text())
    if receipt.get('converted_matrices') != 864:
        raise ValueError('The MTP overlay must complete conversion first')
    config = json.loads((source / 'config.json').read_text())
    text = config.get('text_config', config)
    if text.get('num_hidden_layers') != 45 or text.get('num_nextn_predict_layers') != 1:
        raise ValueError('Unexpected GLM model layout')
    patterns = {'model.language_model.layers.45*', 'model.layers.45*'}
    files = [('config.json', 'quantization_config', 'ignore'),
             ('hf_quant_config.json', 'quantization', 'exclude_modules')]
    changes = []
    for name, section, field in files:
        original = (source / name).read_bytes()
        document = json.loads(original)
        entries = document[section][field]
        if not isinstance(entries, list) or not all(isinstance(item, str) for item in entries):
            raise ValueError('Unexpected quantization metadata')
        document[section][field] = [item for item in entries if item not in patterns]
        replace_json(overlay / name, document)
        changes.append({'file': name, 'source_sha256': hashlib.sha256(original).hexdigest(),
                        'removed': sorted(set(entries) & patterns)})
    replace_json(overlay / 'eleagent-overlay.json', {'schema': 'eleagent.atlas-overlay/v1',
                                                   'metadata': changes})
    print('Overlay MTP metadata prepared; source checkpoint unchanged.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('model_root', type=Path)
    prepare(parser.parse_args().model_root.resolve(strict=True))
