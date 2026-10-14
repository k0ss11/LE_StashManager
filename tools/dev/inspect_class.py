"""
Print fields (with offsets) and methods of a class from any loaded image, live.

    python tools/inspect_class.py System.Collections.Generic HashSet`1
"""
import sys

import frida

AGENT = r"""
const M = Process.getModuleByName('GameAssembly.dll');
const f = (n, r, a) => new NativeFunction(M.getExportByName(n), r, a);
const dom = f('il2cpp_domain_get', 'pointer', []);
f('il2cpp_thread_attach', 'pointer', ['pointer'])(dom());
const s = p => p.isNull() ? '' : p.readUtf8String();
rpc.exports = {
  inspect(ns, name) {
    const out = [];
    const sz = Memory.alloc(8);
    const asms = f('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer'])(dom(), sz);
    for (let i = 0; i < sz.readU32(); i++) {
      const img = f('il2cpp_assembly_get_image', 'pointer', ['pointer'])(asms.add(i * 8).readPointer());
      const k = f('il2cpp_class_from_name', 'pointer', ['pointer', 'pointer', 'pointer'])(img, Memory.allocUtf8String(ns), Memory.allocUtf8String(name));
      if (k.isNull()) continue;
      out.push('// ' + s(f('il2cpp_image_get_name', 'pointer', ['pointer'])(img)));
      const it = Memory.alloc(8); it.writePointer(ptr(0)); let x;
      const fields = f('il2cpp_class_get_fields', 'pointer', ['pointer', 'pointer']);
      while (!(x = fields(k, it)).isNull())
        out.push('  ' + s(f('il2cpp_type_get_name', 'pointer', ['pointer'])(f('il2cpp_field_get_type', 'pointer', ['pointer'])(x)))
          + ' ' + s(f('il2cpp_field_get_name', 'pointer', ['pointer'])(x))
          + ' // 0x' + Number(f('il2cpp_field_get_offset', 'size_t', ['pointer'])(x)).toString(16));
      it.writePointer(ptr(0));
      const meths = f('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
      while (!(x = meths(k, it)).isNull())
        out.push('  ' + s(f('il2cpp_method_get_name', 'pointer', ['pointer'])(x)) + '/' + f('il2cpp_method_get_param_count', 'uint32', ['pointer'])(x));
    }
    return out.join('\n') || 'not found';
  },
};
"""

if __name__ == '__main__':
    session = frida.attach('Last Epoch.exe')
    script = session.create_script(AGENT)
    script.load()
    print(script.exports_sync.inspect(sys.argv[1], sys.argv[2]))
    session.detach()
