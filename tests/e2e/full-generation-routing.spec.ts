import { importPortableChatThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { createChatUiJourneyProfile, expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  seedFirstRun,
  seedLinearChat,
} from './helpers'

const OSS_MODEL = 'qwen/qwen3-4b'
const OPENAI_MODEL = 'gpt-4o-mini'
const VIDEO_MODEL = 'google/veo-3.1-lite'
const LONG_OPENROUTER_DRAFT = `GUI OpenRouter route check ${'x'.repeat(2000)}`
const VALID_MP4_BYTES = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAYkbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAlgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAApl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAlgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAJYAAAQAAABAAAAAAIRbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAIABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABvG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAXxzdGJsAAAAwHN0c2QAAAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAK/+EAGWdkAAqs2UKN+TARAAADAAEAAAMACg8SJZYBAAZo6+PLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAkqoAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAAMAAAgAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAoY3R0cwAAAAAAAAADAAAAAQAAEAAAAAABAAAYAAAAAAEAAAgAAAAAKHN0c2MAAAAAAAAAAgAAAAEAAAACAAAAAQAAAAIAAAABAAAAAQAAACBzdHN6AAAAAAAAAAAAAAADAAAJGAAAAaAAAABIAAAAGHN0Y28AAAAAAAAAAgAABlQAABHzAAACtXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAIAAAAAAAACWAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAAlgAAAQAAAEAAAAAAi1tZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAKxEAABrXFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAAHYbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAGcc3RibAAAAH5zdHNkAAAAAAAAAAEAAABubXA0YQAAAAAAAAABAAAAAAAAAAAAAQAQAAAAAKxEAAAAAAA2ZXNkcwAAAAADgICAJQACAASAgIAXQBUAAAAAARUWAAEVFgWAgIAFEghW5QAGgICAAQIAAAAUYnRydAAAAAAAARUWAAEVFgAAACBzdHRzAAAAAAAAAAIAAAAaAAAEAAAAAAEAAANcAAAAKHN0c2MAAAAAAAAAAgAAAAEAAAABAAAAAQAAAAIAAAAaAAAAAQAAAIBzdHN6AAAAAAAAAAAAAAAbAAAA5wAAASkAAAC9AAAAugAAALsAAADDAAAA6AAAAMMAAACuAAAA1wAAAMkAAADBAAAA1wAAANYAAADWAAAAswAAAKsAAADRAAAA3gAAAM4AAADnAAAA4wAAALYAAACtAAAAvgAAALwAAADSAAAAGHN0Y28AAAAAAAAAAgAAEQwAABI7AAAAGnNncGQBAAAAcm9sbAAAAAIAAAAB//8AAAAcc2JncAAAAAByb2xsAAAAAQAAABsAAAABAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDAAAAAIZnJlZQAAIJ5tZGF0AAACrQYF//+p3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTMgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAZjZYiEABH//veIHzLLb5grHxd3CiQALpu3CL8AtYMSu1pLZP0SjJ1xF40+l9dQDEXMZ43DHHWUkE6XUhuXxLkLdGln6vg8kU0Vgt0k/BU940pViwVwwPEPfEPlFdP+jRdpd/7oAll/FvytFLLcM3OA4CsTnKkMCH5lbKKC8IR1aBOlB/VDd3ibyCorJSvMpeISUWNzD0vuPA44FR1BnJ+S3RY4bZYztVSmnNepBbZnrCZyyqdA4Z/M0cbU1m4/Jy8pUqLEJwrr/CG+Lh5APnxsEajTQptE2+O/WlCeqL1GfmXlKGk2JC12zj3FZpomGWqbvakR0ZZh72/8ZtE1nr9SoAGFsZTUiAHD6rdvvpT4G+dRt0OV5v59/2NLcanCgMtCEDCjtWWkmuqc3Iwlv4tDu6HWuaqPzrwjlNOlJzi/OnuolTNv1CDP970QdweXZF/9jrjuxXvHZcnYm/yrkf/skt+j0alH7d/vxE/XozRfZ7WkzlnBpEMGkb77XPU4rd4eDXCrQRVwgy/9QIbAMrj18WJ3Yv8P6bvm5jqOZhZOhWGIs7vID3qsuO19SlB124SsImqHrFL298LzGC/zhFmeK0O1782wLAAM++nNucD03/6vxByvd7idBSOxnUkzl3CXsQgdgkY/ZdMPJ2LFnM29YIrWahKszUfQFLgNHYIu7j5YAE4FeSO7gBD8JIJ7mHNQZZ9ep237F8wIMzUAAlPx5fmbQwULD99/U3ksDYjj9zV6qGNJs1kvhBGTIEqMQMPlAnvlItWrT3wWymKbCoaqfAzOOL8n81wYdaJcPE61+sI0BpDOJFEr0MbltOdAY67U55edv7eZj3GxtAEYDcP6UVT2oREDNnky4CSfSd2JPqJaR2K0Tzx15KHLOrKqZF/FX/9ux0AqXhyYIzjzQ+S+UgbEcV0ZWrHaS1nYEjFvEk18AVbmtYsQfAjuHeO+fbMrxSda/S0e+v7/UMGCaHXnutLPdqFiwDHM0VpIylMx4sBaUZw5u/QsnbTidlTu8d8Rv7pU6GCI8APS4f9we3iytxB8SQHFTNRgccCggvfqiS6M+dccEC3oR1JSeXvFHLG26LGKddgoukWuziDN7UHnGaHO8kyYMa+cMHxQmbGU5WMLzW0tNkyg5QQglVny7r4Nr3Z8T6PvkBMA642+2dUTxToDZM2pmXBuaUse4e7s+4qJYdeNd1IFIBpTYDOSdip7JoGcjCqQ9Dv8z9h5JL/GWurJqDUTcqIP8exaCHt+Q40CbsNL1dWL8+yQY9DvGsXPZyQ6JydQgWTvihAwznXUDRjITZDwqUJ3ozcRVzxgIjKzSxrDwR6741+4FB3gI5m7VsxQPA/DheY5w8859ZraWdGsrnymCu4r0Clhmx649HoXNf9fzh1BvvEytbg4nA7khdE0xgCuAFiquy1xZs+uwb/d+rPgc/khap8zq6Rdqqn0NBL42nzdO639cqZzxmj+N4mmSZ++e249o+Xx8CTy2A8yZ4ZHczGiODDXV/KApWbQKWz5dG0pqHAh8e2WLsCknF9vmzs3wUArfOpFjJyeBf2gJlAUmPozwFc5YdHTZPPvsEthM4wMN+USIEvXTrYX+hAyLDRUnFnLgqTDUDIjg4XtESrUevFyg9EDtg9V9f8DiSz98C8KwoBtVDSQ4EexWvP4hqY+FfMHMhgR4vLe8cslE34hVuXl5fWfhBlYglFbsKbMt6zxVTNHRKDFU7uA+0xUKtdsTpCqOb71JLdOL5r1d9adrp2Ke7D3hHJ9oFhZlvAuUn++UlO1PLiWEpSxphjuBBmTOvLfKysjRJKNSsDyVGtIxOec6gNZQAJcx5oeFOJspDWswnZcBBT19sae7LAMOk6VR/hTZoxbR0yezMvRgRIk9NUUVV0LS9PrTURcVa4HlHZNbza+CRl1FpWqineM+x+o8z9jzc1nybWGFbWTErc2YBrdOQlCAdEq1oCoknn+5PX05JjPjHJHvA1W9bwXflu3GuRhrsbKjIewB20l1iwh6yz/GT29DdHMnxLj3/5/cUGaMhfgOvBk9z30uLhXZ+FxzpbrGOdfZ6d4RROdmywWelsdcNytg8pt4Z5q2H41hM1FhHyzD4hszUg9/yvnD4VCxpGX/fH3OsHtge1Gx+7T4VCb3q6LyF4CRGbLit5vRvASFjlrG+6s0trxCD+BAAABnEGaImxD//6plgPvNCWIMpIa4AQeUuTf7SYzHhed1P/+z5kybfXAqPvhmiFJD/wH9oE0aW29J69txAoCZ6BSVmNWw2f+q4nvO2GcoSuZZfUFpWZhPAsySVtsqNqF3SXc149jVU0joqRaacV4WXr+MBjs+E4nK+xRJwknx3rzw/V0MEZCnzVt9ofdmW0mWTmjTFa2eQbasTrkt+wDptrrl0O9LbXcv1+ZPMrjZ1EdC3x5ftvNmATGsIdijIfojKS27cBjfOsd70ttvh0dFntV7dVnwqW2XZNNWYzEwP9YhRkHlqGVynB+3P7yXDv6y1dJVvmNKZzkq14t5ePaJ+d6VRyizHinDf5eE4M7TuIeMkNn/1NfKtcGOdQgiUw5tiP8OgUYoyNPbpPOpb5sXbvVhwO8XeeiTCTvT4nvhdmqVoRrCeVPjaa/X+VmixVvEiDF3WOT2LczYX7elqWUB9+Ld5MzQFvWueyI5aZ7hCSf3u17m0DA9bv6+v6qOyPFQ/UufA6bfO5a7CkTv+LHadFCbsxPwEcbk2IQThQZu7zeAgBMYXZjNjIuMjguMTAwAAJUrFup+hQerc2pnzfXxxd0kuVKkySPOcuJAgGLYjBoLT1M3NhNzYrmLmHW1agqr/R+hjNSadaoNzbRsLxXY2xdVcY7Kz7qrYuzs05i13OtdxWNsVhrWJuU7WrDYrDYqzPY3FY2xWGtWG5WG5WGtRsc+xz62jY6Njo1+avylUpVKVSlUpVKVSlUpXKVSlUpVLVS1UpXElElElElElElElElElElElElElElElElElElElElElElElElElElfc/k35r81+a/y/c/ucsssssssssssssssvAAAABEAZ5BeQ//APaw69zMyeITj0kwACUkQIAHB4tKvsdAIERxJ6ER1LI4/nVSlFDmu7dFdHVfsOES0Se35ZYif5qGVvls6oEBTJrZNvFqIlFW4qIXbrMiT9P/188bampxbWc+3wF3d7/j9P+qcaih/T7f7L1rUpQYq6nQ2hpX3CTVs+/SYOSbxlHmFE4Z/WLLavv71rZ21pb8r2d18u20t1izqmlJlTWmSmWmRIpBEDAwMDAwMDAwMDXrwMDAwMbHEs3BgYGBqDObuyOBq5J83Vq89WLUr51LlCAgdjkUdDpsjD2mtiEaZK6TktwzlrRXjuOnPM70lYOwcuh06z3s1tC/etrWWgmhx3r72uxZ01NCFV+KUTjVM6atS1FEvhnTWmb169okJw/Wf6TpnNl5jkxwJCbkY22bOgFnrjEE3Yh831YhF5jM05Z/dbNyqw2KNsU7HNZ6NbNZ6NbNWzVsZNGccKZKXaS92f6bnTeaUFwA+PYttHYhD0Yh0Ij0Ik0Ijfbfib5/p/nrXF8Sb6y6vfW7PqSTnjUy8iq7GG/pYKsqVzRliXrX6b1r8FxttJr4Uuz8K9a+pf/38b8lzV81mpxKNO5hzDiv1PGX11Ztq6ttW1WJU7MtWrXExpKDKSbNlRoJEyxatTJIm2OOOOKFXhhg7gDMzTTIT14Vu4yfDaff3hP8fGZXv7pQ0CRMBGoXg0V7L75lSfTh3h2Tq7uISLGyWvZgLGnslEqAJcAA4DYtcN0LC0bC0aB07hf1+L3n/j/t/z/5feuNyokK1AebrXOQmZbNVVCnbaFGYXdGNPRjN0208bw2jfXCAS37YRVg3NiNzeTwtjleT83Y+VUtXNKppUaUMoMYL7NUQ1CZEozTKE2lNYQOsvxgJhWAqlNauJRImXzQQgdYNzhygpYFElIVBmZTPVKsaNtLzXgmteNtvO8kmWGbk0xAkXvrWFG2iZ7pZ0fo3/8mreX5e2iIznU3Zacl+vwA5jYp0K01B0UB0rB0LC0L8/E3n/x/6f7f+/31bd8+c1cyP4zjmipN22mAaFQRSPdBk6DD4TJxeIgNp9pcXM54r9cr9ks9ck6Cv2RvIN1DdBNBOgWRXuTAGUjBGYLITAFIcyWnJQdyY5EjAzodn3q3HoREbgshtEljKrSCEiFvvRCZomsjkuIUaJxN06hbNDtQJlBWpE4HzdR/jLMEoAkqkoSfnLcnbag2NJmAIHLRsuc7eVAinBLKDM04AOQ2INY4fo4DoYFoYFqlM9X/6f9P5/9v8OK3daqOEf6t6vfIvcvLrLGNi42ttubnc2NxdLzQj5W9z6Def9H7/m+d5vT/Dv6D0vN97md/o20WM8+9HZbiCZKhq5pVS+aO8VFCi48MKkYb986ien6rWtzbJYNlMHa1cRv14v4FMGDq0BlJw4J78INHqgiIhHG3rK90SKU/ZGiu+vYsHha9+SN6cgpZpdY+EX6cRpAhvhjDcu89AVnikqKCe+tV8rTTYCeAAOI2LXC2HpEDAdCw9CwlDo0CoX26rM/7f9P8/+365KGt8Nc6yAK43x3vLupveqlCMYyQona7nbEojI0RkY3n24frmCBeLKKw3RWUdFdjpsnZZOVpbqTVEtMpIpBOixCdFKi0zZBKckZRxsyEBRcDFcOFytDJv8ey8TMELFNaluoqwpkOXGBA5LwlCkfUjy273/Hk+L9QjT1SAnpoglJL70QBXu4Awo4TsZ1NeTESuBGYIEVVGacAODvJoeqpKgBzTiQVSvTGN8izVVX3iaoNJJQJvmiiqzfFATr3sggO7mnXsnCbbuB+zgDoNiDWKisvQoLRsRA6Fg6ZQvXFeOP+3/H7/+f65dc6NCW/N1vjlKZNJl07AoTDQp0MtCnwPnM78yxgIv+2VrZ2Q2vOM7nHto3nG7RXZdtuWFiUr65bleyFuWJYsnk3rahSl7IlvviFoo3mMWk1torn5sr0lLmE1Hb9JLCE/xRfjSaiw7kW9pqEwCJHwg0YDo2WuZWtbaWjnr1Dc6MaCBiJjwEqmABAkjerxj0/vlpM0WDI19d5nVFlHG2mqhSatFle/gDcNi2Q3S0HRQHSsHSPte6f/t/0/3/7/4vm7Zo1KnMDprnRVt2oqxi2EpjricK04XE/Y2pEHEe1H1HNatLh1U0lVN5XjVUgxos69XM34saLGi10yqRKZKHVRH5jRr7JQ5zMYaZnIdlWDHAjYcgu04FkW9Cmpim8V1kI5YTBnzSppwiCkE8IK1BVvacCJSOAS4gqVQmBq0ncRKlJwwvm6savBQRzwSaPOhc6fbtp4ADiNi1Q7SwJhaVA6Jxu7pn/x/x+//v9SbcU0kU/6VrLzOV4qtVdCMYySsUBiURpbPO8tW6uNk0HYuCDrQC6mg5P1fT9XY9bsbrS6bk6bDKkpQpIpM3VHGknhkYYIXwiNgwzrlVOUxSZcVaJoras9lxRLbSQqYnTS7FQbfFaMclVyNbT6MC5wTvXhmXdkRxIU9ME786Ez+DxMzxEOQaPKMzhyOqwPx01/g7EE74YDoJHx3bq7lvHv9lfTQxpokt87c+TWrq+etTX0L1tkmzBEXV7ry0ZL7vgAOw2LVQ2PBdLAdEwtIwdC41VdV/8f8f4/9etVW+KutWqU/FccjF7tUqAA5iNIndkHjC27YzGZ0hhl2kwEF+lcDxIT85P7RZ5yfaN2iuzKXJYWBykosuO2ScxsipBS8GekxROahgQbwT7RvJac/gUYMLg+OEC0yFsFkIucMSEc8I65BXNQcdmFah2A0Bm0ve4g6paB+yfTaU+JnI5i7OltowRKZNPtQFSqh9C4bqnaQ3tDfezdjz55RzYbtkXWOdmGU740tOzH3PAAOA2LRRmVoWDpIFoYFpGDpHjNb3/T/8Pj/3/Xi24456xqoDVNchV7uUqoKaplWWUyzFphh0ww6QTLOBBqDLobm8nqn1+fcdWaaluVLWqWmWtlM0k0mOFHCjCZNdfhdjJQ8VEvhb31aO75yDBhb5wo/VlA6OHFt7ze36cDrMeuoTW+oElCm8cowJdu+E7QTkhlV7cIRCWVhgCUrC4g6EdnChgG+sBIYQO1TDIFimugLggM+mFSCZlMKiKLKagoLVnZwDeNi0w/RMLRMHQsHRMLRMHQsHRPfVc3/4/7fz/79Xqr3drkpAlVMqqJtNSq2Kdp5hYojHUBo6EyVrHXRs6j55nwMmAK2RrGysbKxut+y1NlqZUvAjKkypMpGBZDIk2FIMsLAZULCt7DSeaba9WdhZTjX7nLwbe4bKszDR30nv+QPJrCqWgSEePvveXne/ZTwNrJyvy6/cdEWjfb97SPAES8/Xfajfga0SL3MiE7Ud7mO989YpfeZXECmnAbxoFKLTqIzISavvqGSNNdMpINaUTgcByG+zgAOY2GHZ6GztFAtCwdCwdIgdEonzeu9f9P+38//fzdKvCS5N1H/o5yr1u5uk2HoVFnaHWkW6Ywsz65YFimqUF+lcjxOY/GY/bNfxlPGR8Y3z+Oc8s8s9k3ZkcHkRS0KFSK7tUN5MUmxqRo1DNJ7cUTDKWmugPD+8qt6xhMNIoTVotJ+srxh4Oy8MLYm7KRhlSc6jiQAjCEGGFx6ZN4EBHRMczSjnOGuTMJPwKogtUJhURQSdAtNWUrGqltTL36fRtzi8LRc8Mz4RuPDV8pOEibjNbxZX6eADgNi00Zk6Fh6FhqLRsHQoHSP6/VOf9f/H+n/l9aJ3OgW/+Vm7pubXRUFtUyMK6nS6obFqZh0wmetTdWZLHHoPkT46s1qw46w3Ksx0bWo1+fVylUpVKWFoR6AydvJNJxenDrWyvLCY+c7XAWjsxr++cz3oNtpN7xnmrYeZ0VneggAIZTLCzqIXOlSVI8TRfTluuaCSa28vB0qztR9zSAa9RgLmAlbQZoiWpodoO1ZDLTnH5uJFctKmrz893wkm0vwvpqXayXWiCoNTC5kx1/3uM+X/a3ngA4DYtjJoLG0bC0bB075uc8/0/+n+n/5Z5qevaKrpMVUf3ZVXFKuqgjGMkLJRb0J07G4yczg2ux6fpbnoNYFvb09vWnwKEt7z8/Pfvp995GR8m3YxfdK9N2u1QMGtZ2dAX2U4SXNKgiV1GIWNzvrz5NX3ZTEUGyxeAVDbKLSekL50BnrMKrwqkYRrgGKpTtNbyxsgFJAK1eAxNFo0HZJOX4FHF0kMjIgoASSu874vjOSRquADgNi1w3TQHSsHSuJ635zv+//4fv/+7zmqmJDjdwCqcd7mRapkZQSqx0+cPwyY5gwuGSGZ+Qdkyg2S8SuyaTBqvQmO+Zz7TH7TX7jd2kesr6yPEnsNkuJGqPIOCWE94YI6Dd5UhMgreM5IJ27fNa3FU+MRjvovqsC1IJiHhhE2sjooqcyIxzyQJQGQTuH8HfRXyPZ136stG8Oed982PTEUiaMbjV3xsxL9fgADmNi1Q/RMHRQHRQLRMHSqF+fiVv/+L+//P/t911N3cjOGP6qvcqUmVeaxgg0FGFanTFqZnrFaaxUHc5uS7vDf9or+F7PtezrtzttrutrrtrVVNJmdNnTRElRUiYz0aa0wUTGeKG3YpVMepQm1Wa1LWShvmvTiIy6c2dU0xpaaJ3hsxghTEwJcY8EUGE/HRaftULN/oeqW9E5G7QEOkoIMO/aUTkVryZA1LUtTwP0HGFCe2WuMNRKBm1SVv4eeKpN4BWlExDIs0inLu551VL/twAOA2LVDtEwdFAtCw9CwdIgtC9RvP/H9/5/9fa6mQnFRIBWLmc1KuVN62oO2JCqTdb2NkiFyRJccG8H57rYM/ALpwNX1OXyPX5HL1F3vb8GHeTkJwQwJ4HATQGbCpY4VOVCJy0yrkTLVnEJJTQs7F8nSpT1WJw4MJSdO9eMAuCQokd2PZSMXSly31FyoAUYYVUYXx6WmoUKOUkY8kZjAHxJLNv/A3mh2uYFQd59TFwUBqO8U69UttocAtNTF7wqvCgRZ6Pod9ElmWfZTw8VwfzXf75+y9/lnV/6C/drqcAOQ2INY4IzdHAmHo2DozDon26Vv/X/4/z/v++qyXzfEyCn9vi6K3N1dTK2GZxjvR6y3zO3zOeHVDRKo6BJoHnmtM/M0fmZ/M79ZX2k/TPLEs9U+nRp9YoFFVFRimq52ruJuybg/nCqkQsGbZ8moiWiq6ugPO0ECIw1KZyHfCk2p7ZiIBpWekRJwDnBG9IWdVQ3EDCbowhOksxxK4mYVqZSbbh4ndK6xps9HpJhQuSuVrQddMDVBKSGB5adSy8zKu1EZwpIjj7dq+u4f8XN4A3jYtFGZWhYehYulYOhQLBUL8rb/8f6/z/3+vOX41LqXCBZWrqqNs1SZrYzFiJ5KmStUFg1OxlPIaKvqzw/+d3aT2TVs1xWU2KNbNVTVkZVKWdnmrSMRmq1u1qFM6SXvNJNUZcoouCouzjR8ZNAaxCqIPponNZiuELjtmAgS40kVpJGFxhLrQmQ9lFtm7KVISpVpfSrSXPMHuXgFtPleArtACv1MSCAS12wyWihrJdy4BaQHakAQqdXB2kUgQjQvQsIZBUZHPzBD5G9/uLL9Ad/C/hvLTt4jdbNFdEGdGRumKrFFft4AA6jYg1jgqHYaE0LG0KC0KB0SB0Kvn636/v/f9f/b7y674m+KXXGyn1JVSsqqhQIpSUlq1fI0/IlyDdz8HwYHfy/EPZ6S7uLvIl2FnI35CLEtC9ePfTP9TYYMz9nCasn8YZxuY83N5cGnNFhCZObzRZCvTC5v7/s+feXhikn/3EeaS+55nu0eGv6e3NJWdDOczJQRJ83K27zXkFJII65JAYiCTEYlcqlSyKt8ovARahgAkS3HeMESmcBuo4kR2gcGYw6Iho9ABy389++8Dta5dedDEsTu2wHLe76ubturBxGK6/ADiNiDWRjojQoLQsJRaNA6ZQv4z65v/0/6f5/6/hK31reudVaoAq7rL2lUq8YKnGMcx4vHE4+h54RoqdsyyC/baVw9fp+np48OPDjLRVRVQKClSCOcz6Dfvy6HI/1KICx/8eVK2PYPcnv28b8/akWPuJ3V4dmlPR92hUl3PMdbwm4p8ycysgaKBQNzQZJ+EEawRDvhjSKqe2qwudW4R5cnFM3GFSu8V+jn2XJ9d+BQtGKxmx6+AAOA2Lay9KwdCwtGwdM4XzdVX/j+/4/8/3qV3qusupnD/3K1XdUuKlFULap1iSsTtana7ptm6nTOHbmJjD5281SXN2I3Ncs3RjEoi7na1NOvt662dnxGnBBaQ7ce2kpnpJFaTGqar3AFpvNysu765nIjMEDkWplYqJJqpr7wwthpAoLOjjChe+i854Ko3um3eipWUUeiAMCtcEG2tgKasYlzpquzHPbpI0MDHueAA4jYprN0LB0UB0MB0bC0znvfVf/h/r+//v+Nb1lVeq0TnUBzXMKl1TeqqAVMOwHEHEr+Q2PgIuZ7P/3e1ObgfR4TD1zO8Jh5BmwTpOW3LsususK8GK+EM4pA0sRl5iG9Z2+/SeqiXV58vDomw3me22afV6uFfMl95JMQMFpwA8aH4Iix2RRY4sPAxn+noIIdlN7ZARpKhgClo4wiP1IWmA4TR1KgLBCk6RWXpOvjjtp1UWapdajIFAQKXG0LwAPw2LjSNCwdipK3+f/7n/t/7eaVcmROfOU/quSrReaqVUChSEyjnwdAgJkBbhsBCTWAgBWQSyuMgMsd8UFaBQgHzQ0QgwpNFIkxZCQEmqBdRKAQTGWThWqLH4fVOUfm+fNU9V+MaN8X8Q3D1v5xhvO/wmueg+weh0rjGr2roGZ1rbMzsWuZOSuGTerhk6KkxdSlN5kpWkJV5hG4/CRtzyCmHkEsPIJZbSbLaJylCcpQnCUZWST2ST3vkpcABFjYuVJ2KszW7/19v3r23pTW9GcKj/kkiIiEBEcAgIuBMIkbdAayPnUdQBoJxFsKTEWssjKnW9je1o3IgDsAlOeRBBsweBHwUfrhKOUieEQAa7nZNF4xKwP0s+BloZEAa4B23/49Lc7/M7y1X2DurC9u6K2P4b8Nr/rHzq35bx7B8ltW4551rZdA6Futw4bYbBr2w2TQs5rlqzmghp2+u52CXxtup8pw0fjcNP3HJSdpsz3VbNB1We08JPQKyOgVEc8mH55YP0iwhpFJDSMyW14A=',
  'base64',
)

type CapturedRequest = {
  url: string
  body: Record<string, unknown>
}

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('GUI OpenRouter send, Continue, provider overrides, token-cap routing, and preset save stay on the unified planner', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockChatCompletions(page, requests, ['openrouter ok', ' continued'])
  await mockOpenRouterDiscovery(page)

  await seedFirstRun(page, {
    model: OSS_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })

  await createChatAndOpen(page)
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill(LONG_OPENROUTER_DRAFT)
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="provider-picker"]')).toBeVisible()

  await page.getByRole('tab', { name: 'Context' }).click()
  await expect(page.getByRole('meter', { name: 'Estimated prompt tokens used' })).toContainText('≈')
  await expect(page.locator('[data-ui="context-gauge-breakdown-compact"]')).not.toContainText(
    'draft',
  )
  await page.getByRole('tab', { name: 'Model' }).click()

  await expect(page.getByLabel('Use Tiny Context')).toBeVisible()

  await page.getByRole('radio', { name: 'Throughput' }).click()
  const strict = page.locator('[data-ui="provider-picker-strict"] input')
  await strict.click()
  await expect(strict).toBeChecked()

  const budgetToggle = page.getByLabel('Use Budget Clean')
  await expect(budgetToggle).toBeChecked()
  await budgetToggle.click()
  await expect(budgetToggle).not.toBeChecked()

  await page.locator('[data-ui="preset-breadcrumb-button"]').click()
  await page
    .locator('[data-ui="preset-menu-actions"] [data-ui="field-inline-action"]')
    .first()
    .click()
  await expect(page.locator('[data-ui="preset-breadcrumb-menu"]')).toHaveCount(0)

  await composer.press('Enter')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText('openrouter ok')

  await assistant.locator('[data-action="continue"]').click()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText(
    'openrouter ok continued',
  )

  expect(requests).toHaveLength(2)
  expect(JSON.stringify(requests[0]?.body.messages)).toContain(LONG_OPENROUTER_DRAFT)
  for (const req of requests) {
    expect(req.url).toContain('/chat/completions')
    expect(req.body.model).toBe(OSS_MODEL)
    const provider = req.body.provider as Record<string, unknown>
    expect(provider).toMatchObject({
      data_collection: 'deny',
      sort: 'throughput',
      require_parameters: true,
    })
    expect(provider.ignore).toEqual(
      expect.arrayContaining([
        'Budget Clean',
        'Fast Retain',
        'Training Host',
        'Tiny Context',
        'UserID Host',
      ]),
    )
  }

  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

test('Context resolves the complete long active branch without transcript scrolling', async ({
  page,
}) => {
  await mockOpenRouterDiscovery(page)
  await seedFirstRun(page, {
    model: OSS_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  const chatId = await seedLinearChat(page, {
    messageCount: 160,
    chatId: 'long-context-active-branch',
    title: 'Long context active branch',
    textForIndex: (index) =>
      index === 17
        ? `long context body ${'context unit '.repeat(18_000)}`
        : `short context ${index}`,
    settings: {
      'global:message-initial-render-work': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await expect(page).toHaveURL(new RegExp(`#/chat/${chatId}(?:/message/[^/]+)?$`, 'u'))
  await expect(page.getByText('short context 159', { exact: true })).toBeVisible()
  await page.locator('[data-role="settings-cog"]').click()
  await page.getByRole('tab', { name: 'Context' }).click()

  const meter = page.getByRole('meter', { name: 'Estimated prompt tokens used' })
  await expect(meter).toBeVisible()
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeGreaterThan(10_000)
})

test('Context reopens from its exact estimate and follows the selected branch', async ({
  page,
}) => {
  await mockOpenRouterDiscovery(page)
  await seedFirstRun(page, {
    model: OSS_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  const fixture = await seedContextBranches(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.branchALeafId}`)
  await expect(page.getByText('context branch A assistant', { exact: true })).toBeVisible()

  await openContextPanel(page)
  const meter = page.getByRole('meter', { name: 'Estimated prompt tokens used' })
  await expect(meter).toBeVisible()
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeGreaterThan(10_000)
  const exactBranchAEstimate = Number(await meter.getAttribute('aria-valuenow'))

  await page.locator('[data-role="settings-pane-close"]').click()
  await expect(page.locator('[data-ui="chat-model-panel"]')).toHaveCount(0)
  const volatileDraft = `volatile meter-independent draft ${'z'.repeat(20_000)}`
  await page.locator('[data-ui="composer-input"]').fill(volatileDraft)
  await openContextPanel(page)
  await expect(meter).toHaveAttribute('aria-valuenow', String(exactBranchAEstimate))
  await expect(page.getByText('Waiting for prompt estimate…', { exact: true })).toHaveCount(0)

  await page.locator('[data-role="settings-pane-close"]').click()
  await page.locator('[data-ui="composer-input"]').fill('')
  const branchAUser = page
    .locator('[data-ui="message"][data-role="user"]')
    .filter({ hasText: 'context branch A user' })
  await branchAUser.getByLabel('Next variant').click()
  await expect(page.getByText('context branch B assistant', { exact: true })).toBeVisible()

  await openContextPanel(page)
  await expect(meter).toBeVisible()
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeLessThan(exactBranchAEstimate / 10)
  await expect(page.getByText('Waiting for prompt estimate…', { exact: true })).toHaveCount(0)
})

test('GUI OpenAI-compatible send uses Responses and never carries OpenRouter provider/privacy wire', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const responsesRequests: CapturedRequest[] = []
  await mockOpenAiDirect(page, responsesRequests)

  await seedFirstRun(page, { model: OSS_MODEL, disablePrivacyFilter: false })
  await seedLinearChat(page, {
    messageCount: 1,
    chatId: 'openai-direct-routing-chat',
    title: 'OpenAI direct routing chat',
    textPrefix: 'existing public fixture message',
  })
  await addOpenAiConnectionThroughGui(page)

  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="provider-picker"]')).toHaveCount(0)
  await expect(page.locator('[data-ui-section="privacy-section"]')).toHaveCount(0)
  await page.locator('[data-ui="model-picker-search-input"]').fill(OPENAI_MODEL)
  await page
    .locator('[data-ui="picker-row-pick"]')
    .filter({ hasText: OPENAI_MODEL })
    .first()
    .click()

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('GUI OpenAI direct route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'openai direct ok',
  )

  expect(responsesRequests).toHaveLength(1)
  expect(responsesRequests[0]?.url).toBe('https://api.openai.com/v1/responses')
  expect(responsesRequests[0]?.body.model).toBe(OPENAI_MODEL)
  expect(responsesRequests[0]?.body.provider).toBeUndefined()
  expect(responsesRequests[0]?.body.input).toBeDefined()
  expect(responsesRequests[0]?.body.messages).toBeUndefined()

  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

test('GUI OpenRouter video model uses parent /endpoints architecture for UI and send routing', async ({
  page,
  uiJourney,
}) => {
  const consoleLines = captureConsole(page)
  const videoRequests: CapturedRequest[] = []
  const videoDownloads: string[] = []
  let releaseVideoDownloads = () => {}
  const videoDownloadGate = new Promise<void>((resolve) => {
    releaseVideoDownloads = resolve
  })
  await mockOpenRouterDiscovery(page, VIDEO_MODEL)
  await mockOpenRouterVideos(page, videoRequests, videoDownloads, videoDownloadGate)

  await seedFirstRun(page, {
    model: VIDEO_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })

  const observerChatId = await seedLinearChat(page, {
    messageCount: 2,
    chatId: 'video-localization-observer',
    title: 'Video localization observer',
  })

  await createChatAndOpen(page)
  const observer = await page.context().newPage()
  await mockOpenRouterVideos(observer, videoRequests, videoDownloads, videoDownloadGate)
  await observer.goto(`/#/chat/${observerChatId}`)
  await expect(observer.locator('[data-ui="app-shell"]')).toHaveAttribute(
    'data-workspace-runtime-state',
    'RUNNING',
  )
  await expect(observer).toHaveURL(new RegExp(`#/chat/${observerChatId}/message/[^/]+$`, 'u'))
  const observerComposerForm = observer.locator(
    'form[data-ui="composer"]:not([data-presentation-only])',
  )
  await expect(observerComposerForm).toBeVisible()
  const observerComposer = observerComposerForm.locator('[data-ui="composer-input"]')
  await observerComposer.fill('local observer draft remains selected')
  await observerComposer.focus()
  const journeyProfile = createChatUiJourneyProfile()
  await uiJourney.start(
    observer,
    {
      ...journeyProfile,
      semanticNodes: [
        ...(journeyProfile.semanticNodes ?? []),
        {
          id: 'composer-draft',
          selector: '[data-ui="composer-input"]',
          properties: { value: { kind: 'stable' } },
          resetOnRouteChange: false,
        },
      ],
    },
    'remote-generated-output-locality',
  )
  await uiJourney.intent(observer, {
    kind: 'focus-continuity',
    id: 'remote-generated-output-focus',
    selector: '[data-ui="composer-input"]',
    preserveSelection: true,
  })
  await uiJourney.intent(observer, {
    kind: 'follow-bottom',
    id: 'remote-generated-output-scroll',
  })
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('GUI video route check')
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="api-mode"]')).toHaveCount(0)
  await page.locator('[data-ui="settings-tab"][data-tab="context"]').click()
  await expect(page.locator('[data-ui-section="context-control"]')).toContainText(
    'Video generation does not expose a token context window.',
  )

  const videoMedia = page
    .locator('[data-ui="message"][data-role="assistant"]')
    .first()
    .locator('[data-ui="message-output-media"][data-media="video"]')
  const videoElements = videoMedia.locator('video')
  await composer.press('Enter')
  try {
    await expect(videoMedia).toHaveCount(2)
    expect(
      await videoElements.evaluateAll((nodes) =>
        nodes.map((node) => ({
          src: node.getAttribute('src') ?? '',
          preload: node.getAttribute('preload'),
        })),
      ),
    ).toEqual([
      {
        src: 'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=0',
        preload: 'none',
      },
      {
        src: 'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=1',
        preload: 'none',
      },
    ])

    expect(videoRequests).toHaveLength(1)
    expect(videoRequests[0]?.url).toContain('/videos')
    expect(videoRequests[0]?.body).toMatchObject({
      model: VIDEO_MODEL,
      prompt: 'GUI video route check',
    })
    expect(videoRequests[0]?.body.provider).toMatchObject({ data_collection: 'deny' })
  } finally {
    releaseVideoDownloads()
  }

  const expectedDownloads = [
    'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=0',
    'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=1',
  ]
  await expect.poll(() => [...videoDownloads].sort()).toEqual([...expectedDownloads].sort())
  await expect
    .poll(() =>
      videoElements.evaluateAll((nodes) =>
        nodes.map((node) => (node.getAttribute('src') ?? '').startsWith('blob:')),
      ),
    )
    .toEqual([true, true])

  await expect(observerComposer).toHaveValue('local observer draft remains selected')
  await uiJourney.finish(observer, 'remote-generated-output-localized')
  await observer.close()

  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

async function seedContextBranches(page: Page): Promise<{ chatId: string; branchALeafId: string }> {
  const now = Date.now()
  const sourceChatId = 'context-branch-refresh-chat'
  const imported = await importPortableChatThroughUi(page, {
    sourceChatId,
    title: 'Context branch refresh chat',
    createdAt: now,
    updatedAt: now + 5,
    captureMessageIds: true,
    messages: [
      {
        id: 'root',
        chatId: sourceChatId,
        parentId: null,
        siblingIndex: 0,
        turnId: 'turn-root',
        turnIndex: 0,
        createdAt: now,
        role: 'system',
        origin: 'imported',
        content: [{ type: 'text', text: 'context root instruction' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'A1',
        chatId: sourceChatId,
        parentId: 'root',
        siblingIndex: 0,
        turnId: 'turn-A1',
        turnIndex: 1,
        createdAt: now + 1,
        role: 'user',
        origin: 'user',
        content: [
          {
            type: 'text',
            text: `context branch A user ${'context unit '.repeat(18_000)}`,
          },
        ],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'A2',
        chatId: sourceChatId,
        parentId: 'A1',
        siblingIndex: 0,
        turnId: 'turn-A2',
        turnIndex: 2,
        createdAt: now + 2,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'context branch A assistant' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'B1',
        chatId: sourceChatId,
        parentId: 'root',
        siblingIndex: 1,
        turnId: 'turn-B1',
        turnIndex: 1,
        createdAt: now + 3,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'context branch B user' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'B2',
        chatId: sourceChatId,
        parentId: 'B1',
        siblingIndex: 0,
        turnId: 'turn-B2',
        turnIndex: 2,
        createdAt: now + 4,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'context branch B assistant' }],
        nodeVersion: 0,
        deleted: false,
      },
    ],
  })
  const branchALeafId = imported.messageIdMap?.A2
  if (!branchALeafId) throw new Error('Context branch fixture message id missing')
  return { chatId: imported.chatId, branchALeafId }
}

async function openContextPanel(page: Page): Promise<void> {
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  await page.getByRole('tab', { name: 'Context' }).click()
}

function captureConsole(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') lines.push(`${msg.type()}: ${msg.text()}`)
  })
  return lines
}

async function mockChatCompletions(
  page: Page,
  requests: CapturedRequest[],
  replies: readonly string[],
): Promise<void> {
  await page.route('**/chat/completions', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body })
    const idx = requests.length - 1
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': `gui-chat-${idx + 1}` },
      body: buildSseBody([
        {
          id: `gui-chat-${idx + 1}`,
          model: stringField(body, 'model'),
          provider: 'Alpha ZDR',
          content: replies[idx] ?? 'ok',
        },
        {
          finish: 'stop',
          usage: {
            prompt_tokens: 12,
            completion_tokens: 2,
            total_tokens: 14,
            cost: 0.000001,
          },
        },
      ]),
    })
  })
}

async function mockOpenAiDirect(page: Page, responsesRequests: CapturedRequest[]): Promise<void> {
  await page.route('https://api.openai.com/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: OPENAI_MODEL, object: 'model', created: 0, owned_by: 'openai' }],
      }),
    })
  })
  await page.route('https://api.openai.com/v1/responses', async (route) => {
    const body = parsePostBody(route.request().postData())
    responsesRequests.push({ url: route.request().url(), body })
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': 'gui-resp-1' },
      body: buildResponsesSse('openai direct ok'),
    })
  })
}

async function mockOpenRouterDiscovery(page: Page, modelId: string = OSS_MODEL): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(openRouterModelsPayload(modelId)),
    })
  })
  await page.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(openRouterEndpointsPayload(modelId)),
    })
  })
  await page.route('**/_or_scrape/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { providers: openRouterProviderPolicyRows(modelId) } },
      })}</script>`,
    })
  })
}

async function mockOpenRouterVideos(
  page: Page,
  requests: CapturedRequest[],
  downloads: string[],
  videoDownloadGate: Promise<void> = Promise.resolve(),
): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/videos/video-gui-1/content**', async (route) => {
    downloads.push(route.request().url())
    await videoDownloadGate
    await route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      body: VALID_MP4_BYTES,
    })
  })
  await page.route('https://openrouter.ai/api/v1/videos', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'video-gui-1',
        generation_id: 'video-gui-1',
        polling_url: 'https://openrouter.ai/api/v1/videos/video-gui-1',
        status: 'completed',
        unsigned_urls: [
          'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=0',
          'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=1',
        ],
        usage: { cost: 0.001 },
      }),
    })
  })
}

function buildResponsesSse(text: string): string {
  const events = [
    {
      type: 'response.created',
      response: { id: 'resp_gui', model: OPENAI_MODEL, status: 'in_progress' },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_gui',
        model: OPENAI_MODEL,
        status: 'completed',
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')
}

function parsePostBody(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function openRouterModelsPayload(modelId: string): Record<string, unknown> {
  if (modelId === VIDEO_MODEL) {
    return {
      data: [
        {
          id: modelId,
          name: 'Veo 3.1 Lite',
          context_length: 0,
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['video'],
            tokenizer: 'Other',
          },
          pricing: { image: '0.02' },
          supported_parameters: ['max_tokens', 'temperature', 'top_p', 'seed', 'response_format'],
        },
      ],
    }
  }
  return {
    data: [
      {
        id: modelId,
        name: 'Qwen3 4B',
        context_length: 131_072,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'qwen3',
        },
        pricing: { prompt: '0.00000004', completion: '0.00000008' },
        supported_parameters: ['temperature', 'max_completion_tokens', 'provider'],
      },
    ],
  }
}

function openRouterEndpointsPayload(modelId: string): Record<string, unknown> {
  if (modelId === VIDEO_MODEL) {
    return {
      data: {
        id: modelId,
        name: 'Veo 3.1 Lite',
        context_length: 0,
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['video'],
          tokenizer: 'Other',
        },
        endpoints: [
          {
            provider_name: 'Google',
            provider_slug: 'google',
            supported_parameters: ['max_tokens', 'temperature', 'top_p', 'seed'],
            context_length: 0,
            max_prompt_tokens: null,
            max_completion_tokens: null,
            pricing: { image: '0.02' },
          },
        ],
      },
    }
  }
  return {
    data: {
      id: modelId,
      name: 'Qwen3 4B',
      context_length: 131_072,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'qwen3',
      },
      endpoints: [
        endpoint('Alpha ZDR', 131_072, 120_000, '0.00000004', '0.00000008'),
        endpoint('Budget Clean', 131_072, 120_000, '0.00000003', '0.00000006'),
        endpoint('Tiny Context', 1, 1, '0.00000002', '0.00000005'),
        endpoint('Fast Retain', 131_072, 120_000, '0.00000005', '0.00000009'),
        endpoint('Training Host', 131_072, 120_000, '0.00000001', '0.00000002'),
        endpoint('UserID Host', 131_072, 120_000, '0.00000004', '0.00000008'),
      ],
    },
  }
}

function endpoint(
  provider_name: string,
  context_length: number,
  max_prompt_tokens: number,
  prompt: string,
  completion: string,
): Record<string, unknown> {
  return {
    provider_name,
    supported_parameters: ['temperature', 'max_completion_tokens'],
    context_length,
    max_prompt_tokens,
    max_completion_tokens: 4096,
    pricing: { prompt, completion },
    quantization: 'bf16',
    uptime_last_30m: 99.9,
    throughput_last_30m: { p50: 120 },
  }
}

function openRouterPolicies(modelId: string = OSS_MODEL): Record<string, Record<string, unknown>> {
  if (modelId === VIDEO_MODEL) {
    return {
      Google: policy({}),
    }
  }
  return {
    'Alpha ZDR': policy({}),
    'Budget Clean': policy({}),
    'Tiny Context': policy({}),
    'Fast Retain': policy({ retainsPrompts: true, retentionDays: 30 }),
    'Training Host': policy({ training: true }),
    'UserID Host': policy({ requiresUserIDs: true }),
  }
}

function openRouterProviderPolicyRows(modelId: string = OSS_MODEL): Array<Record<string, unknown>> {
  return Object.entries(openRouterPolicies(modelId)).map(([provider_name, data_policy]) => ({
    provider_name,
    data_policy,
  }))
}

function policy(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    training: false,
    trainingOpenRouter: false,
    retainsPrompts: false,
    canPublish: false,
    termsOfServiceURL: '',
    privacyPolicyURL: '',
    ...overrides,
  }
}

async function addOpenAiConnectionThroughGui(page: Page): Promise<void> {
  const row = page.locator('[data-ui="connection-row"]')
  if ((await row.count()) === 0) {
    await page.locator('[data-ui="connection-provider-button"]').click()
    await expect(row).toBeVisible()
  }
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click()
  }
  await page.locator('[data-ui="connection-new"]').click()
  await page.locator('[data-ui="connection-setup-kind"]').selectOption('openai-compatible')
  await page.locator('[data-ui="connection-setup-key"]').fill('sk-test-openai')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
}
