#!/usr/bin/env python3
"""Package the plugin only, preserving UTF-8 filenames and file permissions."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json
import os

root = Path(__file__).resolve().parent.parent
source = root / 'plugin' / 'codex-conversation-tree'
version = json.loads((source / 'plugin.json').read_text())['version']
destination = root / 'dist' / f'codex-conversation-tree-{version}-macOS.zip'
destination.parent.mkdir(exist_ok=True)
temporary = destination.with_suffix('.tmp')
with ZipFile(temporary, 'w', ZIP_DEFLATED, compresslevel=9) as archive:
    archive.write(source, source.name + '/')
    for file in sorted(source.rglob('*')):
        relative = file.relative_to(source)
        if set(relative.parts) & {'hooks', 'data', 'node_modules', '.git'} or file.name == '.DS_Store':
            continue
        archive.write(file, str(Path(source.name) / relative))
with ZipFile(temporary) as archive:
    installer = archive.getinfo('codex-conversation-tree/安装.command')
    assert installer.flag_bits & 0x800, 'UTF-8 installer filename must be preserved'
    assert (installer.external_attr >> 16) & 0o111, 'Installer must be executable'
    assert archive.testzip() is None
os.replace(temporary, destination)
print(destination)
