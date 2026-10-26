# Arazi (topografya) çalışması — devir notu

Bu dal (`terrain`) Kahramanmaraş'ı gerçek yükseklik verisinin üzerine oturtma işini içeriyor. **Henüz bitmedi**; canlı site `main` dalından yayınlanıyor ve bundan etkilenmiyor.

## Yaklaşım

- **Veri:** AWS'nin açık Terrarium yükseklik karoları (SRTM tabanlı, anahtar gerekmez). `tools/city/fetch.mjs` karoları `tools/data/kahramanmaras/terrain/` klasörüne indiriyor; `tools/city/terrain.mjs` bunları harita verisine iki ızgara olarak işliyor:
  - Şehir: 30 m aralıklı ince ızgara.
  - Çevre: 100 m aralıklı kaba ızgara, ufuktaki dağlar (Ahır Dağı) için.
  - Yükseklikler Atatürk Meydanı'na (573 m) göre. İnce ızgara kenarında kabaya yumuşakça geçiyor.
- **Zemin yüzeyi:** Her ızgara hücresi aynı köşegenle iki üçgene bölünmüş, doğrusal bir yüzey. Hem CPU (`heightAt`) hem GPU (`terrainHeightNode`) aynı fonksiyonu kullanıyor (`js/terrain.js`).
- **Simülasyon düz kalıyor:** Trafik, yayalar, fizik, çarpışmalar ve culling hücreleri değişmedi. Yalnızca çizim zemine oturuyor:
  - **Statik şehir** (`bakeTerrain`, açılışta bir kez): zemin katmanları (yol, kaldırım, bordür, çim, yol çizgileri) ızgara çizgileri ve köşegenler boyunca kesilip tam zemine oturtuluyor. Binalar ve çatılar köşe köşe yükseltiliyor. Instanced nesneler (ağaçlar vb.) bütün halinde yükseltiliyor.
  - **Hareket edenler** (araçlar, yayalar, oyuncu, sinyaller): vertex shader'da yükseltiliyor (`liftMaterials`). Bunların frustum culling'i kapatıldı, çünkü sınırları düz düzlemde kalıyor.
  - **Kamera** (`cameras.js`) ve **hareketli lambalar** (`liftLights`) her karede yükseltiliyor.
  - **Cephe kat çizgileri ve sokak gölgelemesi** `deckY` ile "zeminden yükseklik" hesaplıyor.
- **Çevredeki dağlar:** Kıyısı olmayan şehirde deniz düzlemi yerine `createRegionGround` (kaba ızgara + 30 km'lik etek) ve `createRegionGroundMaterial` (bozkır, tarla, kaya) kullanılıyor.

## Durum

Yapılan ve test edilen (görünmez Chrome, WebGL 2):
- Şehir yüklenip zemine oturuyor; sokakların eğimi ve helikopterden yamaca tırmanan şehir görünüyor. Konsol hatası yok.
- Zemin katmanlarına kesimle eklenen üçgen: +2,4M; vertex'ler kaynaştırılıyor (indexed).

Yapılan ama **henüz test edilmeyen** son iki düzeltme:
1. Oyuncu taksisi görünmüyordu (düz sınırları yüzünden culling'e takılıyordu): `liftMaterials` artık yükselttiği nesnelerde `frustumCulled = false` yapıyor.
2. Gökyüzünde/uzak dağlarda karıncalanma vardı (uzaktaki ince desen aliasing yapıyordu): `createRegionGroundMaterial` ince desenleri uzaklıkla söndürüyor.

Yapılacaklar:
- **Açılış süresi:** `bakeTerrain` ~10 s sürüyor. Plan:
  - Kesilmeyen üçgenleri ara bellek ayırmadan kopyalamak.
  - Vertex kaynaştırmada `Map` yerine typed-array hash tablosu kullanmak.
  - `readAttribute` için hızlı yol eklemek.
- `main.js`'deki `[terrain] baked ...` log satırı ve `terrain.js`'deki `stats.heavy` teşhis amaçlı; iş bitince sadeleştirilecek.
- Gerçek WebGPU'lu bir tarayıcıda ve telefonda performans ölçümü.
- Kontrol edilecekler: helikopter görünümü, yokuşta araçlar, gölgelerin hizası, gece lambaları.
- Bitince `main`'e birleştirip yayınlamak.

## Başka bilgisayarda devam etmek

```sh
git clone https://github.com/mhmmd5225/SLOPMARAS.git
cd SLOPMARAS
git checkout terrain
python -m http.server 8000 --bind 127.0.0.1    # http://127.0.0.1:8000/
```

Haritayı yeniden üretmek için Node.js gerekli:

```sh
node tools/city/fetch.mjs kahramanmaras                                # eksik veri varsa indirir
node --max-old-space-size=8192 tools/city/build.mjs kahramanmaras      # js/kahramanmaras-geodata.js
```

Claude Code ile devam ederken ona bu dosyayı okut: kaldığımız yer ve sıradaki adım burada.
