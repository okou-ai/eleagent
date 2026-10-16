import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_overlay', Path(__file__).with_name('prepare-overlay.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OverlayMetadataTests(unittest.TestCase):
    def test_replaces_links_without_changing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'nvidia--GLM-5.3-Flash-NVFP4'
            overlay = root / 'atlas-overlay'
            source.mkdir()
            overlay.mkdir()
            patterns = ['lm_head', 'model.language_model.layers.45*', 'model.layers.45*']
            config = {'text_config': {'num_hidden_layers': 45, 'num_nextn_predict_layers': 1},
                      'quantization_config': {'ignore': patterns}}
            quant = {'quantization': {'exclude_modules': patterns}}
            originals = {}
            for name, document in [('config.json', config), ('hf_quant_config.json', quant)]:
                originals[name] = json.dumps(document).encode()
                (source / name).write_bytes(originals[name])
                (overlay / name).symlink_to(source / name)
            (overlay / 'conversion.complete.json').write_text('{"converted_matrices":864}')
            module.prepare(root)
            module.prepare(root)
            for name, original in originals.items():
                self.assertEqual((source / name).read_bytes(), original)
                self.assertFalse((overlay / name).is_symlink())
            self.assertEqual(json.loads((overlay / 'config.json').read_text())
                             ['quantization_config']['ignore'], ['lm_head'])
            self.assertEqual(json.loads((overlay / 'hf_quant_config.json').read_text())
                             ['quantization']['exclude_modules'], ['lm_head'])

    def test_rejects_incomplete_conversion_before_metadata_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            overlay = root / 'atlas-overlay'
            overlay.mkdir()
            (overlay / 'conversion.complete.json').write_text('{"converted_matrices":863}')
            with self.assertRaisesRegex(ValueError, 'complete conversion'):
                module.prepare(root)
            self.assertFalse((overlay / 'config.json').exists())


if __name__ == '__main__':
    unittest.main()
