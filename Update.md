# Nhật Ký Cập Nhật Tính Năng & Nâng Cấp Hệ Thống
### Dự án: Threads to TikTok Video Generator (Tích hợp VieNeu-TTS)

Tài liệu này tổng hợp toàn bộ các tính năng, cải tiến kiến trúc, bản sửa lỗi và hướng dẫn sử dụng chi tiết đã được triển khai từ đầu cuộc trò chuyện đến thời điểm hiện tại.

---

## 1. Tích Hợp Giọng Đọc AI VieNeu-TTS & Hệ Thống Caching
- **Triển khai môi trường ảo**: Cài đặt Python venv tại `/Volumes/Data/VieNeu-TTS/.venv` với đầy đủ các thư viện phụ thuộc (`torch`, `torchaudio`, `onnxruntime`, `neuphonic`, v.v.).
- **Tạo giọng đọc tự nhiên**: Tích hợp mô hình TTS tiếng Việt chất lượng cao (giọng mẫu mặc định: Trúc Ly).
- **Bộ nhớ đệm thông minh (Voice Cache)**:
  - Lưu trữ tại thư mục cache `tts_cache/` dựa trên mã băm SHA-256 của từng đoạn văn bản đọc.
  - Tự động đo lường và trả về chính xác thời lượng phát âm (audio duration tính bằng giây) của từng câu.
  - Khi người dùng chỉnh sửa meme, đổi nhạc hay di chuyển vị trí thẻ mà không sửa lời đọc, hệ thống tái sử dụng audio cache ngay lập tức mà không cần gọi lại TTS.

---

## 2. Kho Tài Nguyên (Resource Management)
Hệ thống quản lý tài nguyên được bố trí trực quan trong tab **Kho tài nguyên** và các mục thiết lập:
- **Video nền (`Video nền/`)**:
  - Tải lên video nền mới (.mp4, .mov, .webm).
  - Tự động đo thời lượng video qua ffprobe.
  - **Chọn điểm bắt đầu video nền (Background Start Offset)**: Đối với các video nền dài (trên 15 giây hoặc trên 1 phút), hệ thống hiển thị thanh trượt chọn mốc thời gian bắt đầu (`bgStart`), kèm nút **🎲 Ngẫu nhiên** (chọn ngẫu nhiên một phân đoạn khác nhau cho mỗi video) và nút **Đặt lại** (về 00:00).
- **Meme hình ảnh (`Memes/`)**:
  - Tải lên meme (.png, .jpg, .webp, .gif) vào thư viện.
  - Hiển thị danh sách thumbnail meme trực quan, nhấn để gán ngay vào phân đoạn đang chọn.
- **Hiệu ứng âm thanh (`Sound Effects/`)**:
  - Hỗ trợ upload các file âm thanh reaction/sfx (.mp3, .wav, .aac, .ogg, .flac).
  - Thư viện hiệu ứng hiển thị dạng danh sách chip kèm nút **Nghe thử (Play / Stop)** độc lập.
- **Font chữ (`Fonts/`)**:
  - Thư mục lưu trữ font chữ tùy chỉnh.
  - Hỗ trợ tải lên font (.ttf, .otf, .woff, .woff2), tự động đăng ký với trình duyệt qua FontFace API và đưa vào gói render MP4.

---

## 3. Meme Tương Tác & Sửa Lỗi Hiển Thị
- **Kéo thả & Thay đổi kích thước trực quan (Interactive Stage)**:
  - Người dùng có thể kéo thả meme trực tiếp trên khung xem thử để đặt vị trí bất kỳ (tọa độ x%, y%).
  - Nút handle góc dưới bên phải meme cho phép kéo để phóng to / thu nhỏ kích thước.
- **Tùy chọn thời điểm xuất hiện của Meme**:
  - **Cùng lúc với thẻ nội dung (`with_card`)**: Meme xuất hiện song song ngay từ đầu phân đoạn.
  - **Sau khi đọc xong (`after_read`)**: Sau khi AI đọc xong nội dung bài viết/bình luận, meme mới bật lên đồng bộ với hiệu ứng âm thanh reaction.
- **Sửa triệt để lỗi phóng to vỡ hình (100x Zoom Bug)**:
  - *Nguyên nhân*: Giao diện web lưu giá trị thanh trượt dạng phần trăm số nguyên (ví dụ `scale = 100` tương ứng 100%), nhưng khi chuyển sang HyperFrames và CSS thì lại áp dụng trực tiếp thành `--meme-scale: 100` (khiến hình ảnh bị phóng đại gấp 100 lần, che kín màn hình thành một mảng màu mờ).
  - *Khắc phục*: Tự động chuẩn hóa tỉ lệ scale (`rawScale > 10 ? rawScale / 100 : rawScale`), đảm bảo meme luôn hiển thị sắc nét đúng kích cỡ thiết lập.

---

## 4. Phụ Đề TikTok Nhảy Từng Chữ & Font Be Vietnam Pro
- **Hiệu ứng chữ nhảy TikTok**: Phụ đề tự động ngắt dòng thông minh (mặc định 6-8 từ / dòng, có thanh trượt tùy chỉnh) và từ đang được đọc sẽ nổi bật bằng màu vàng TikTok (`#FFE600`) kèm hiệu ứng phóng to nhẹ (pop animation) đồng bộ chính xác 100% với giọng đọc.
- **Font chữ chuẩn**:
  - Chuyển font chữ mặc định sang **Be Vietnam Pro** (phiên bản Black 900 & Bold 700) được đóng gói sẵn trong dự án (`public/fonts/`), đảm bảo hiển thị tiếng Việt chuẩn đẹp, đều đặn, không bị lỗi dấu tiếng Việt và hoàn toàn độc lập với mạng internet khi render.
  - Cung cấp danh sách lựa chọn font và nút **Thêm font** để người dùng tải lên các font chữ yêu thích.

---

## 5. Xem Thử Trực Tiếp Thời Gian Thực (Live Preview 0s)
- **Cơ chế xem thử không cần chờ render**:
  - Tích hợp trình phát Live Preview mô phỏng toàn bộ video ngay trên canvas trình duyệt bằng GSAP Timeline, Web Audio API và HTML5 Video.
  - Nghe thử giọng đọc AI + hiệu ứng mở đầu + âm thanh reaction + nhạc nền + video nền + meme + phụ đề nhảy chữ trong nháy mắt.
  - Chỉnh sửa meme, di chuyển thẻ hay đổi âm thanh là có thể bấm **▷ Phát thử (Live)** kiểm tra ngay lập tức, không tốn thời gian render lại nhiều lần.
- **Cơ chế nghe thử âm thanh chuẩn xác**:
  - Khắc phục lỗi phát đè âm thanh: khi đổi hiệu ứng khác hoặc bấm nghe thử mới, âm thanh cũ tự động dừng ngay lập tức.
  - Nút nghe thử chuyển đổi linh hoạt giữa icon **Phát (Play)** và **Dừng (Square)**.

---

## 6. Nâng Cấp Màn Kết Video (Outro)
- **Tùy chọn nền Outro (Blur Video vs Nền Đen)**:
  - Thêm công tắc **Làm mờ video nền ở phần kết (`outro-blur-bg`)**:
    - **Khi BẬT (Mặc định)**: Sau khi đọc hết bài viết và các bình luận, toàn bộ thẻ chữ ẩn đi, video nền vẫn tiếp tục phát mượt mà nhưng được áp dụng hiệu ứng kính mờ (`backdrop-filter: blur(28px)`), làm nổi bật thông báo kêu gọi Follow, avatar và tài khoản.
    - **Khi TẮT**: Video nền dừng lại và chuyển sang nền đen hiện đại (`#050609`).
  - Hỗ trợ nút **Xem thử outro** riêng biệt để căn chỉnh nội dung kết video.

---

## 7. Nhập Bình Luận Thủ Công Với Cú Pháp Chuẩn
- Bổ sung ô nhập bình luận thủ công hỗ trợ cú pháp nghiêm ngặt:
  ```text
  [Tên user] Nội dung bình luận
  hoặc
  [Tên user] Nội dung bình luận | Số tim
  ```
- **Ví dụ**:
  ```text
  [jstnzp.wav] hôm nay trời đẹp quá
  [lapzone] video này bổ ích ghê | 128
  ```
- Tự động kiểm tra lỗi (Syntax Validation) và hiển thị thông báo chi tiết số dòng vi phạm nếu người dùng nhập thiếu ngoặc vuông hoặc thiếu nội dung.

---

## 8. Giao Diện Người Dùng Hiện Đại (Lucide Icons & Thời Lượng Video)
- **Thư viện Lucide Icons**: Thay thế toàn bộ ký tự Unicode, emoji thô sơ trên thanh công cụ, các tab thanh bên (sidebar), nút bấm thao tác và các thẻ danh sách bằng bộ icon SVG vector chuyên nghiệp của `lucide`.
- **Hiển thị thời lượng video thời gian thực (`⏱ ~MM:SS`)**:
  - Huy hiệu hiển thị thời lượng dự kiến đặt ở topbar và cập nhật liên tục khi thêm bớt cảnh, bật tắt outro, đổi hiệu ứng hoặc khi VieNeu-TTS sinh giọng đọc.

---

## 9. Xuất Video MP4 Toàn Bộ
- Giữ nguyên nút **Xuất MP4** để dựng video hoàn chỉnh độ phân giải cao 1080 × 1920 với chất lượng cao nhất thông qua HyperFrames headless Chromium + FFmpeg.
- Tự động xuất file kết quả vào thư mục `Xuất ra/` và cung cấp nút tải về trực tiếp.

---

## 10. Tùy Biến Avatar Màn Kết Video (Outro Avatar)
- **Tải lên & Quản lý Avatar tùy chỉnh**:
  - Thêm thư mục `Avatars/` để lưu trữ ảnh đại diện kênh của người dùng.
  - Hỗ trợ các định dạng ảnh phổ biến: `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`.
  - Bổ sung nút **Đổi avatar** và **Đặt lại** (về avatar mặc định) ngay tại bảng cấu hình Outro ở thanh bên.
- **Xem trước & Render chuẩn xác**:
  - Ảnh đại diện hiển thị lập tức trong khung xem trước Outro (Live Preview) với khung bo tròn sắc nét.
  - Tích hợp tự động vào tiến trình HyperFrames: sao chép avatar sang thư mục render và ánh xạ đường dẫn chính xác, giúp video MP4 xuất ra hiển thị đúng avatar của kênh thay vì ảnh mặc định `lapzone-logo.svg`.

---

## 11. Hỗ Trợ Meme Đa Định Dạng (Ảnh, GIF & Video)
- **Mở rộng hỗ trợ định dạng Meme**:
  - Không còn giới hạn ở ảnh tĩnh; hệ thống hỗ trợ đầy đủ ảnh động **GIF** (`.gif`) và các định dạng **Video** (`.mp4`, `.webm`, `.mov`).
  - Thư mục lưu trữ: `Memes/`.
- **Hiển thị & Tương tác thông minh**:
  - Danh sách Meme trong Kho tài nguyên tự động nhận diện file video, gắn nhãn huy hiệu **VIDEO** và hiển thị thời lượng chi tiết.
  - Trên màn hình tương tác (Interactive Stage): Meme video hiển thị dưới dạng `<video>` chạy lặp mượt mà (`autoplay loop muted playsinline`), hỗ trợ đầy đủ thao tác kéo thả vị trí và co giãn kích thước bằng chuột.
  - Render HyperFrames MP4: Tự động nhúng video clip vào dòng thời gian render frame-by-frame của Chromium không bị giật lag hay lệch khung hình.

---

## 12. Cơ Chế Chờ Âm Thanh & Meme Chạy Hết Mới Chuyển Cảnh
- **Đo lường thời lượng chính xác qua FFprobe**:
  - Backend tự động đo độ dài thực tế của từng hiệu ứng âm thanh trong `Sound Effects/` và từng video meme trong `Memes/`.
  - Tăng trần thời lượng hiệu ứng âm thanh từ 4s lên tới 12s, tránh tình trạng âm thanh dài bị cắt cụt.
- **Khóa chuyển cảnh thông minh (Duration Lockstep)**:
  - Khi phân đoạn có hiệu ứng âm thanh hoặc meme (đặc biệt là video meme hoặc meme xuất hiện sau khi đọc xong), thời gian chờ sau đọc (`reactionDur`) được tính toán chuẩn xác:
    $$\text{reactionDur} = \max(\text{effectDuration}, \text{memeDuration}, \text{holdTime})$$
  - Phân đoạn tiếp theo chỉ được chuyển sang khi **cả âm thanh và meme đều đã chạy trọn vẹn 100% thời lượng**.
- **Đệm âm thanh (Audio Silence Padding) chống lệch nhịp**:
  - Khi thời lượng hình ảnh được kéo dài để chờ video meme, hệ thống tự động sinh file âm thanh tĩnh (`hold-${index}.wav`) tương ứng và ghép vào luồng âm thanh chính qua FFmpeg `concat`.
  - Giúp loại bỏ hoàn toàn hiện tượng giọng đọc của cảnh sau phát sớm đè lên cảnh trước khi render video hoàn chỉnh.
