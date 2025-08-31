#![allow(clippy::not_unsafe_ptr_arg_deref)]
use super::audio::*;
use std::slice;

#[no_mangle]
pub extern "C" fn ffi_audio_init(sample_rate: f32) { engine_init(sample_rate) }

#[no_mangle]
pub extern "C" fn ffi_audio_process_into(out_l_ptr: *mut f32, out_r_ptr: *mut f32, len: usize) -> u32 {
    if out_l_ptr.is_null() || out_r_ptr.is_null() { return 0 }
    unsafe {
        let out_l = slice::from_raw_parts_mut(out_l_ptr, len);
        let out_r = slice::from_raw_parts_mut(out_r_ptr, len);
        engine_process_into(out_l, out_r)
    }
}

