"""Extend original LED PCB into matching standard-symbol schematic, preserving original evidence."""
from pathlib import Path
import argparse
import json
import os
import uuid


def symbol(source: Path, name: str, library: str) -> str:
    text=source.read_text(); start=text.index('(symbol "'+name+'"'); depth=0; quoted=False; escape=False
    for end in range(start,len(text)):
        char=text[end]
        if escape: escape=False; continue
        if char=='\\' and quoted: escape=True; continue
        if char=='"': quoted=not quoted
        if not quoted:
            if char=='(': depth+=1
            if char==')':
                depth-=1
                if depth==0: return text[start:end+1].replace('(symbol "'+name+'"','(symbol "'+library+':'+name+'"',1)
    raise ValueError('Incomplete library symbol')


def build(output: Path, original: Path, *, symbols: Path) -> None:
    """Extend only the original generator's pad numbering; never overwrite an output."""
    import pcbnew as pcb

    if not original.is_file():
        raise FileNotFoundError("Original PCB does not exist")
    for library in ["Device", "Connector_Generic"]:
        if not (symbols / (library + ".kicad_sym")).is_file():
            raise FileNotFoundError("Required KiCad symbol library is missing")
    output.mkdir(exist_ok=False,parents=True); uid=lambda:str(uuid.uuid4()); root=uid()
    specs=[('J1','Connector_Generic','Conn_01x02','5V input',50.8,50.8,[('+5V',45.72,50.8),('GND',45.72,53.34)]),('R1','Device','R','330 ohm',76.2,50.8,[('+5V',76.2,46.99),('LED_A',76.2,54.61)]),('D1','Device','LED','Red LED',101.6,50.8,[('GND',97.79,50.8),('LED_A',105.41,50.8)])]
    libraries=[symbol(symbols/(lib+'.kicad_sym'),name,lib) for _,lib,name,_,_,_,_ in specs]
    parts=['(kicad_sch (version 20250114) (generator "eeschema") (uuid "'+root+'") (paper "A4") (lib_symbols '+'\n'.join(libraries)+')']
    ids={}
    for ref,lib,name,value,x,y,pins in specs:
        ident=uid(); ids[ref]=ident
        parts.append(f'(symbol (lib_id "{lib}:{name}") (at {x} {y} 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "{ident}") (property "Reference" "{ref}" (at {x} {y-5} 0) (effects (font (size 1.27 1.27)))) (property "Value" "{value}" (at {x} {y+5} 0) (effects (font (size 1.27 1.27)))) (property "Footprint" "" (at {x} {y} 0) (effects (font (size 1.27 1.27)) (hide yes))) (instances (project "led" (path "/{root}" (reference "{ref}") (unit 1)))))')
        for net,px,py in pins:
            parts.append(f'(label "{net}" (at {px} {py} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "{uid()}"))')
    parts.append('(embedded_fonts no))'); (output/'led.kicad_sch').write_text('\n'.join(parts))
    (output/'sym-lib-table').write_text('(sym_lib_table (version 7) '+''.join(f'(lib (name "{lib}")(type "KiCad")(uri {json.dumps((symbols.resolve() / (lib + ".kicad_sym")).as_posix())})(options "")(descr ""))' for lib in ['Device','Connector_Generic'])+')')
    board=pcb.LoadBoard(str(original))
    for net in board.GetNetsByNetcode().values():
        if net.GetNetname(): net.SetNetname('/'+net.GetNetname().lstrip('/'))
    for fp in board.GetFootprints():
        ref=fp.GetReference()
        if ref=='D1':
            for pad in fp.Pads(): pad.SetNumber('2' if pad.GetNumber()=='1' else '1')
        path=pcb.KIID_PATH(); path.push_back(pcb.KIID(root)); path.push_back(pcb.KIID(ids[ref])); fp.SetPath(path)
        fp.SetSheetname(''); fp.SetSheetfile('led.kicad_sch')
    pcb.SaveBoard(str(output/'led.kicad_pcb'),board)
    (output/'expected-nets.json').write_text(json.dumps({'+5V':['J1.1','R1.1'],'LED_A':['R1.2','D1.2'],'GND':['J1.2','D1.1']},indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('original', type=Path, help='The intermediate PCB produced by kicad_led.py, not the final numbered board')
    parser.add_argument('--symbols', type=Path, default=Path(os.environ.get('KICAD_SYMBOL_DIR', '/usr/share/kicad/symbols')))
    options = parser.parse_args()
    build(options.output, options.original, symbols=options.symbols)
