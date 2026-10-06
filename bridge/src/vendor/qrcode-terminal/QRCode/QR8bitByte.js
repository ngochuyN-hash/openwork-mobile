// Vendored from qrcode-terminal@0.12.0 — Apache-2.0 (c) Gord Tanner, Michael Brooks.
// QR engine: "QRCode for JavaScript" (c) 2009 Kazuhiko Arase — MIT. See LICENSE.
// Converted CommonJS -> ESM; logic unchanged.
import QRMode from "./QRMode.js";
function QR8bitByte(data) {
	this.mode = QRMode.MODE_8BIT_BYTE;
	this.data = data;
}

QR8bitByte.prototype = {

	getLength : function() {
		return this.data.length;
	},
	
	write : function(buffer) {
		for (var i = 0; i < this.data.length; i++) {
			// not JIS ...
			buffer.put(this.data.charCodeAt(i), 8);
		}
	}
};

export default QR8bitByte;