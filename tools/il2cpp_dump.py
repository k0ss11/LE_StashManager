"""
Live IL2CPP dumper for Last Epoch (Unity 6 / metadata v39, which Il2CppDumper can't read).

Attaches with Frida and walks classes through the il2cpp_* exports. Only metadata
queries are made (no managed calls), so it is safe from the Frida thread.

Usage:  python il2cpp_dump.py [out_file] [--images LE.dll,Assembly-CSharp.dll]
Output: dump.cs-like text: fields with offsets, methods with RVA and signature.
"""
import sys
import frida

AGENT = r"""
const M = Process.getModuleByName('GameAssembly.dll');
const f = (n, r, a) => new NativeFunction(M.getExportByName(n), r, a);
const domain_get = f('il2cpp_domain_get', 'pointer', []);
const thread_attach = f('il2cpp_thread_attach', 'pointer', ['pointer']);
const get_asms = f('il2cpp_domain_get_assemblies', 'pointer', ['pointer', 'pointer']);
const asm_img = f('il2cpp_assembly_get_image', 'pointer', ['pointer']);
const img_name = f('il2cpp_image_get_name', 'pointer', ['pointer']);
const img_cnt = f('il2cpp_image_get_class_count', 'size_t', ['pointer']);
const img_cls = f('il2cpp_image_get_class', 'pointer', ['pointer', 'size_t']);
const c_name = f('il2cpp_class_get_name', 'pointer', ['pointer']);
const c_ns = f('il2cpp_class_get_namespace', 'pointer', ['pointer']);
const c_parent = f('il2cpp_class_get_parent', 'pointer', ['pointer']);
const c_decl = f('il2cpp_class_get_declaring_type', 'pointer', ['pointer']);
const c_fields = f('il2cpp_class_get_fields', 'pointer', ['pointer', 'pointer']);
const c_meths = f('il2cpp_class_get_methods', 'pointer', ['pointer', 'pointer']);
const c_isize = f('il2cpp_class_instance_size', 'int', ['pointer']);
const c_isenum = f('il2cpp_class_is_enum', 'bool', ['pointer']);
const c_isiface = f('il2cpp_class_is_interface', 'bool', ['pointer']);
const c_isvt = f('il2cpp_class_is_valuetype', 'bool', ['pointer']);
const fl_name = f('il2cpp_field_get_name', 'pointer', ['pointer']);
const fl_off = f('il2cpp_field_get_offset', 'size_t', ['pointer']);
const fl_flags = f('il2cpp_field_get_flags', 'int', ['pointer']);
const fl_type = f('il2cpp_field_get_type', 'pointer', ['pointer']);
const fl_static_get = f('il2cpp_field_static_get_value', 'void', ['pointer', 'pointer']);
const t_name = f('il2cpp_type_get_name', 'pointer', ['pointer']);
const m_name = f('il2cpp_method_get_name', 'pointer', ['pointer']);
const m_pc = f('il2cpp_method_get_param_count', 'uint32', ['pointer']);
const m_param = f('il2cpp_method_get_param', 'pointer', ['pointer', 'uint32']);
const m_pname = f('il2cpp_method_get_param_name', 'pointer', ['pointer', 'uint32']);
const m_ret = f('il2cpp_method_get_return_type', 'pointer', ['pointer']);
const m_flags = f('il2cpp_method_get_flags', 'uint32', ['pointer', 'pointer']);

thread_attach(domain_get());
const s = p => p.isNull() ? '' : p.readUtf8String();
const tn = t => t.isNull() ? '?' : s(t_name(t));
let classes = null;

function full(k) { const d = c_decl(k); return d.isNull() ? (s(c_ns(k)) ? s(c_ns(k)) + '.' : '') + s(c_name(k)) : full(d) + '/' + s(c_name(k)); }

function dumpClass(k, img) {
  const out = [];
  const kind = c_isenum(k) ? 'enum' : c_isiface(k) ? 'interface' : c_isvt(k) ? 'struct' : 'class';
  const par = c_parent(k);
  out.push(`// ${img}  size=0x${c_isize(k).toString(16)}`);
  out.push(`${kind} ${full(k)}${par.isNull() ? '' : ' : ' + full(par)} {`);
  const it = Memory.alloc(8); it.writePointer(ptr(0)); let fi;
  const tmp = Memory.alloc(8);
  while (!(fi = c_fields(k, it)).isNull()) {
    const fl = fl_flags(fi); const isStatic = (fl & 0x10) !== 0; const isLit = (fl & 0x40) !== 0;
    let line = `  ${isLit ? 'const ' : isStatic ? 'static ' : ''}${tn(fl_type(fi))} ${s(fl_name(fi))};`;
    if (isLit && c_isenum(k)) { try { tmp.writeU64(0); fl_static_get(fi, tmp); line += ` // = ${tmp.readS32()}`; } catch (e) {} }
    else if (!isLit) line += ` // 0x${Number(fl_off(fi)).toString(16)}`;
    out.push(line);
  }
  if (!c_isenum(k)) {
    it.writePointer(ptr(0)); let m;
    while (!(m = c_meths(k, it)).isNull()) {
      const n = m_pc(m); const ps = [];
      for (let i = 0; i < n; i++) ps.push(tn(m_param(m, i)) + ' ' + s(m_pname(m, i)));
      const mf = m_flags(m, ptr(0)); const fp = m.readPointer();
      const rva = fp.isNull() ? 'abstract' : 'RVA 0x' + fp.sub(M.base).toString(16);
      out.push(`  ${(mf & 0x10) ? 'static ' : ''}${tn(m_ret(m))} ${s(m_name(m))}(${ps.join(', ')}); // ${rva}`);
    }
  }
  out.push('}');
  return out.join('\n');
}

rpc.exports = {
  init(images) {
    classes = [];
    const sz = Memory.alloc(8); const arr = get_asms(domain_get(), sz); const n = sz.readU32();
    for (let i = 0; i < n; i++) {
      const img = asm_img(arr.add(i * 8).readPointer()); const iname = s(img_name(img));
      if (images.length && images.indexOf(iname) < 0) continue;
      const cc = Number(img_cnt(img));
      for (let j = 0; j < cc; j++) classes.push([img_cls(img, j), iname]);
    }
    return classes.length;
  },
  chunk(start, count) {
    const r = [];
    for (let i = start; i < Math.min(start + count, classes.length); i++) {
      try { r.push(dumpClass(classes[i][0], classes[i][1])); } catch (e) { r.push('// error ' + e); }
    }
    return r.join('\n\n');
  },
};
"""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    out_path = args[0] if args else 'dump_live.cs'
    images = []
    if '--images' in sys.argv:
        images = sys.argv[sys.argv.index('--images') + 1].split(',')
        if images[0] in args:
            args.remove(images[0])

    session = frida.attach('Last Epoch.exe')
    script = session.create_script(AGENT)
    script.load()
    api = script.exports_sync
    total = api.init(images)
    print(f'[+] {total} classes')
    with open(out_path, 'w', encoding='utf-8') as fh:
        for start in range(0, total, 500):
            fh.write(api.chunk(start, 500))
            fh.write('\n\n')
            print(f'\r[*] {min(start + 500, total)}/{total}', end='', flush=True)
    print(f'\n[+] wrote {out_path}')
    script.unload()
    session.detach()


if __name__ == '__main__':
    main()
